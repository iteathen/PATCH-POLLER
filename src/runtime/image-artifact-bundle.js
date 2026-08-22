import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { baseImageIdentity } from '../values/base-image-identity.js';
import {
  IMAGE_ARTIFACT_MANIFEST_PROTOCOL,
  imageArtifactManifestDigest,
  normalizeImageArtifactManifest,
  serializeImageArtifactManifest,
} from './image-artifact-manifest.js';

export const DEFAULT_IMAGE_ARTIFACT_CHUNK_BYTES = 1024 * 1024 * 1024;
const COPY_BYTES = 8 * 1024 * 1024;

async function sha256(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

async function createOwnedDirectory(directory) {
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('artifact bundle destination already exists');
    throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('artifact bundle destination must be a real directory');
}

async function writeChunk(sourceHandle, destination, offset, size) {
  const output = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(COPY_BYTES, size));
  let copied = 0;
  try {
    while (copied < size) {
      const requested = Math.min(buffer.length, size - copied);
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, offset + copied);
      if (bytesRead !== requested) throw new Error('encoded artifact ended before declared chunk boundary');
      const frame = buffer.subarray(0, bytesRead);
      await output.write(frame, 0, frame.length, copied);
      hash.update(frame);
      copied += frame.length;
    }
    await output.sync();
  } finally {
    await output.close();
  }
  return { size: copied, sha256: hash.digest('hex') };
}

export async function buildImageArtifactBundle({
  canonical,
  destination,
  profile,
  generation,
  format,
  virtualSize,
  bootstrap,
  codec,
  chunkBytes = DEFAULT_IMAGE_ARTIFACT_CHUNK_BYTES,
} = {}) {
  if (typeof canonical !== 'string' || canonical.length === 0) throw new TypeError('canonical image source is required');
  if (typeof destination !== 'string' || destination.length === 0) throw new TypeError('artifact bundle destination is required');
  if (!codec || typeof codec.describe !== 'function' || typeof codec.encode !== 'function') throw new TypeError('artifact encoding contract is incomplete');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError('artifact chunk size must be a positive safe integer');
  const input = path.resolve(canonical);
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('canonical image source must be a real file');
  const root = path.resolve(destination);
  await createOwnedDirectory(root);
  const encoded = path.join(root, `.encoded-${randomUUID()}.tmp`);
  try {
    const canonicalMeasured = await sha256(input);
    if (canonicalMeasured.size < 1) throw new Error('canonical image must not be empty');
    const identity = baseImageIdentity(profile, generation, canonicalMeasured.sha256);
    const description = await codec.describe();
    if (!description || typeof description.algorithm !== 'string' || !description.parameters) throw new TypeError('artifact encoding description is invalid');

    // Encoding consumes the complete canonical image and produces one complete
    // encoded object. Transport chunking starts only after whole-object measurement.
    await codec.encode({ source: input, destination: encoded });
    const encodedMeasured = await sha256(encoded);
    if (encodedMeasured.size < 1) throw new Error('encoded image must not be empty');

    const chunks = [];
    const encodedHandle = await open(encoded, 'r');
    try {
      let offset = 0;
      let ordinal = 0;
      while (offset < encodedMeasured.size) {
        const size = Math.min(chunkBytes, encodedMeasured.size - offset);
        const name = encodedMeasured.size <= chunkBytes
          ? `${identity}.encoded`
          : `${identity}.part-${String(ordinal).padStart(6, '0')}`;
        const measured = await writeChunk(encodedHandle, path.join(root, name), offset, size);
        chunks.push({ ordinal, name, offset, size: measured.size, sha256: measured.sha256 });
        offset += size;
        ordinal += 1;
      }
    } finally {
      await encodedHandle.close();
    }

    const manifest = normalizeImageArtifactManifest({
      protocol: IMAGE_ARTIFACT_MANIFEST_PROTOCOL,
      image: { identity, profile, generation, format, virtualSize, size: canonicalMeasured.size, sha256: canonicalMeasured.sha256, bootstrap },
      encoding: { algorithm: description.algorithm, parameters: description.parameters, size: encodedMeasured.size, sha256: encodedMeasured.sha256 },
      chunks,
    });
    const manifestName = `${identity}.manifest.json`;
    const temporaryManifest = path.join(root, `.manifest-${randomUUID()}.tmp`);
    await writeFile(temporaryManifest, serializeImageArtifactManifest(manifest), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryManifest, path.join(root, manifestName));
    return Object.freeze({ manifest, manifestDigest: imageArtifactManifestDigest(manifest), manifestName, chunkNames: Object.freeze(chunks.map((entry) => entry.name)) });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(encoded, { force: true }).catch(() => {});
  }
}
