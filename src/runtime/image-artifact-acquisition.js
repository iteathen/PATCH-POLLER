import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { imageArtifactManifestDigest, normalizeImageArtifactManifest } from './image-artifact-manifest.js';

const COPY_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const ROOT_TEMP = /^\.(?:encoded|canonical)-[a-f0-9-]{36}\.tmp$/u;
const DOWNLOAD_TEMP = /^\.download-[a-f0-9-]{36}\.tmp$/u;
async function sha256(file) { const hash = createHash('sha256'); let size = 0; for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; } return { sha256: hash.digest('hex'), size }; }
async function regularFile(file) { try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink(); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function verifiedFile(file, expected) { if (!await regularFile(file)) return false; const measured = await sha256(file); return measured.size === expected.size && measured.sha256 === expected.sha256; }
async function concatenate(chunks, destination) { const output = await open(destination, 'wx', 0o600); const buffer = Buffer.alloc(COPY_BYTES); let outputOffset = 0; try { for (const chunk of chunks) { const input = await open(chunk, 'r'); try { let inputOffset = 0; while (true) { const { bytesRead } = await input.read(buffer, 0, buffer.length, inputOffset); if (bytesRead === 0) break; await output.write(buffer, 0, bytesRead, outputOffset); inputOffset += bytesRead; outputOffset += bytesRead; } } finally { await input.close(); } } await output.sync(); } finally { await output.close(); } }
function usableLocal(value, generation) { if (!value || value.verified !== true || value.usable !== true) return false; if (generation != null && value.entry?.generation !== generation) return false; return true; }

export class ImageArtifactAcquisition {
  #directory; #local; #source; #codec; #capacity; #tail = Promise.resolve();
  constructor({ directory, local, source, codec, capacity = null } = {}) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('image acquisition directory is required');
    if (!local || typeof local.verify !== 'function' || typeof local.publish !== 'function') throw new TypeError('local image admission contract is incomplete');
    if (!source || typeof source.manifest !== 'function' || typeof source.fetch !== 'function') throw new TypeError('image source contract is incomplete');
    if (!codec || typeof codec.decode !== 'function') throw new TypeError('image decoding contract is incomplete');
    if (capacity != null && typeof capacity.ensure !== 'function') throw new TypeError('image recovery capacity contract is incomplete');
    this.#directory = path.resolve(directory); this.#local = local; this.#source = source; this.#codec = codec; this.#capacity = capacity;
  }
  #serial(work) { const next = this.#tail.then(work, work); this.#tail = next.catch(() => {}); return next; }
  async #reconcileTemp(directory, pattern) { for (const name of await readdir(directory)) if (pattern.test(name)) await rm(path.join(directory, name), { force: true }); }
  async #ensureDirectories(encodedDigest) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 }); const info = await lstat(this.#directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('image acquisition directory must be a real directory');
    await this.#reconcileTemp(this.#directory, ROOT_TEMP);
    const chunks = path.join(this.#directory, 'chunks', encodedDigest); await mkdir(chunks, { recursive: true, mode: 0o700 }); const chunkInfo = await lstat(chunks); if (!chunkInfo.isDirectory() || chunkInfo.isSymbolicLink()) throw new Error('image acquisition chunk directory must be a real directory');
    await this.#reconcileTemp(chunks, DOWNLOAD_TEMP); return chunks;
  }
  async #chunk(root, entry) {
    const final = path.join(root, entry.name); if (await verifiedFile(final, entry)) return { file: final, reused: true };
    await rm(final, { force: true }); const temporary = path.join(root, `.download-${randomUUID()}.tmp`);
    try { await this.#source.fetch({ name: entry.name, destination: temporary, size: entry.size }); if (!await verifiedFile(temporary, entry)) throw new Error(`image transport chunk failed verification: ${entry.ordinal}`); await rename(temporary, final); return { file: final, reused: false }; } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async #ensureUnlocked({ identity, generation = null, validate = null } = {}) {
    if (typeof identity !== 'string' || !/^img-[a-f0-9]{32}$/u.test(identity)) throw new TypeError('image identity is invalid');
    if (generation != null && (typeof generation !== 'string' || generation.length === 0)) throw new TypeError('image generation is invalid');
    if (validate != null && typeof validate !== 'function') throw new TypeError('image validation contract is invalid');
    const localBefore = await this.#local.verify(identity); if (usableLocal(localBefore, generation)) return Object.freeze({ state: 'local', image: localBefore });
    const supplied = await this.#source.manifest({ identity });
    if (!supplied || typeof supplied !== 'object' || !DIGEST.test(String(supplied.digest ?? '').toLowerCase())) throw new Error('image source did not provide an exact manifest digest');
    const manifest = normalizeImageArtifactManifest(supplied.manifest); const manifestDigest = imageArtifactManifestDigest(manifest);
    if (manifestDigest !== String(supplied.digest).toLowerCase()) throw new Error('image manifest digest does not match canonical manifest bytes');
    if (manifest.image.identity !== identity) throw new Error('image source returned another image identity');
    if (generation != null && manifest.image.generation !== generation) throw new Error('image source returned another image generation');
    if (this.#codec.algorithm != null && this.#codec.algorithm !== manifest.encoding.algorithm) throw new Error('image encoding is unsupported by the selected decoder');
    const chunkRoot = await this.#ensureDirectories(manifest.encoding.sha256);
    let downloadBytes = 0; for (const entry of manifest.chunks) if (!await verifiedFile(path.join(chunkRoot, entry.name), entry)) downloadBytes += entry.size;
    if (this.#capacity) await this.#capacity.ensure({ downloadBytes, encodedBytes: manifest.encoding.size, canonicalBytes: manifest.image.size, replacementBytes: localBefore?.exists === true ? manifest.image.size : 0 });
    const chunks = []; let reusedChunks = 0; for (const entry of manifest.chunks) { const acquired = await this.#chunk(chunkRoot, entry); chunks.push(acquired.file); if (acquired.reused) reusedChunks += 1; }
    const encoded = path.join(this.#directory, `.encoded-${randomUUID()}.tmp`); const canonical = path.join(this.#directory, `.canonical-${randomUUID()}.tmp`);
    try {
      await concatenate(chunks, encoded); const encodedMeasured = await sha256(encoded); if (encodedMeasured.size !== manifest.encoding.size || encodedMeasured.sha256 !== manifest.encoding.sha256) throw new Error('complete encoded image failed verification');
      await this.#codec.decode({ source: encoded, destination: canonical, algorithm: manifest.encoding.algorithm, parameters: manifest.encoding.parameters });
      const canonicalMeasured = await sha256(canonical); if (canonicalMeasured.size !== manifest.image.size || canonicalMeasured.sha256 !== manifest.image.sha256) throw new Error('reconstructed canonical image failed verification');
      if (localBefore?.entry != null || localBefore?.exists === true) { if (typeof this.#local.quarantine !== 'function') throw new Error('invalid local image requires an exact quarantine capability before replacement'); await this.#local.quarantine(identity); }
      const published = await this.#local.publish({ profile: manifest.image.profile, generation: manifest.image.generation, source: canonical, expectedDigest: manifest.image.sha256, provenance: { origin: 'verified-artifact-reconstruction', manifest_sha256: manifestDigest, encoding_sha256: manifest.encoding.sha256, bootstrap: manifest.image.bootstrap } }, { validate });
      if (published?.identity !== identity) throw new Error('local image admission returned another image identity'); const verified = await this.#local.verify(identity); if (!usableLocal(verified, manifest.image.generation)) throw new Error('locally admitted reconstructed image did not verify');
      return Object.freeze({ state: 'reconstructed', image: verified, manifest, reusedChunks });
    } finally { await rm(encoded, { force: true }).catch(() => {}); await rm(canonical, { force: true }).catch(() => {}); }
  }
  ensure(input) { return this.#serial(() => this.#ensureUnlocked(input)); }
}
