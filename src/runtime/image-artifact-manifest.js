import { createHash } from 'node:crypto';
import { baseImageIdentity } from '../values/base-image-identity.js';

export const IMAGE_ARTIFACT_MANIFEST_PROTOCOL = 'devbridge/image-artifact-manifest-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_PARAMETERS = 32;
const MAX_PARAMETER_BYTES = 512;
const MAX_CHUNKS = 16384;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function safeLeaf(value, name) {
  if (typeof value !== 'string' || value === '.' || value === '..' || !SAFE_LEAF.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function positive(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`); return value; }
function nonnegative(value, name) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`); return value; }
function digest(value, name) { const normalized = String(value ?? '').toLowerCase(); if (!DIGEST.test(normalized)) throw new TypeError(`${name} is invalid`); return normalized; }

function normalizeParameters(raw) {
  const value = requireObject(raw, 'image artifact encoding.parameters');
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMETERS) throw new TypeError('image artifact encoding.parameters is too large');
  const normalized = {};
  for (const [key, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const name = safeId(key, 'image artifact encoding parameter name');
    if (typeof rawValue !== 'string' || rawValue.includes('\0') || Buffer.byteLength(rawValue, 'utf8') > MAX_PARAMETER_BYTES) {
      throw new TypeError(`image artifact encoding.parameters.${name} is invalid`);
    }
    normalized[name] = rawValue;
  }
  return Object.freeze(normalized);
}

function normalizeImage(raw) {
  const value = requireObject(raw, 'image artifact image');
  onlyKeys(value, new Set(['identity', 'profile', 'generation', 'format', 'virtualSize', 'size', 'sha256', 'bootstrap']), 'image artifact image');
  const profile = safeId(value.profile, 'image artifact image.profile');
  const generation = safeId(value.generation, 'image artifact image.generation');
  const sha256 = digest(value.sha256, 'image artifact image.sha256');
  const identity = safeId(value.identity, 'image artifact image.identity');
  if (identity !== baseImageIdentity(profile, generation, sha256)) throw new TypeError('image artifact image.identity does not match its semantic image subject');
  return Object.freeze({
    identity,
    profile,
    generation,
    format: safeId(value.format, 'image artifact image.format').toLowerCase(),
    virtualSize: positive(value.virtualSize, 'image artifact image.virtualSize'),
    size: positive(value.size, 'image artifact image.size'),
    sha256,
    bootstrap: safeId(value.bootstrap, 'image artifact image.bootstrap'),
  });
}

function normalizeEncoding(raw) {
  const value = requireObject(raw, 'image artifact encoding');
  onlyKeys(value, new Set(['algorithm', 'parameters', 'size', 'sha256']), 'image artifact encoding');
  return Object.freeze({
    algorithm: safeId(value.algorithm, 'image artifact encoding.algorithm'),
    parameters: normalizeParameters(value.parameters),
    size: positive(value.size, 'image artifact encoding.size'),
    sha256: digest(value.sha256, 'image artifact encoding.sha256'),
  });
}

function normalizeChunks(raw, encodedSize) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CHUNKS) throw new TypeError('image artifact chunks are invalid');
  const names = new Set();
  let expectedOffset = 0;
  const chunks = raw.map((rawChunk, index) => {
    const value = requireObject(rawChunk, `image artifact chunks[${index}]`);
    onlyKeys(value, new Set(['ordinal', 'name', 'offset', 'size', 'sha256']), `image artifact chunks[${index}]`);
    if (value.ordinal !== index) throw new TypeError('image artifact chunk ordinals must be contiguous and ordered');
    const name = safeLeaf(value.name, `image artifact chunks[${index}].name`);
    if (names.has(name)) throw new TypeError('image artifact chunk names must be unique');
    names.add(name);
    const offset = nonnegative(value.offset, `image artifact chunks[${index}].offset`);
    if (offset !== expectedOffset) throw new TypeError('image artifact chunks must provide contiguous encoded coverage');
    const size = positive(value.size, `image artifact chunks[${index}].size`);
    expectedOffset += size;
    return Object.freeze({ ordinal: index, name, offset, size, sha256: digest(value.sha256, `image artifact chunks[${index}].sha256`) });
  });
  if (expectedOffset !== encodedSize) throw new TypeError('image artifact chunks do not exactly cover the encoded object');
  return Object.freeze(chunks);
}

export function normalizeImageArtifactManifest(raw) {
  const value = requireObject(raw, 'image artifact manifest');
  onlyKeys(value, new Set(['protocol', 'image', 'encoding', 'chunks']), 'image artifact manifest');
  if (value.protocol !== IMAGE_ARTIFACT_MANIFEST_PROTOCOL) throw new TypeError('image artifact manifest protocol is unsupported');
  const image = normalizeImage(value.image);
  const encoding = normalizeEncoding(value.encoding);
  return Object.freeze({
    protocol: IMAGE_ARTIFACT_MANIFEST_PROTOCOL,
    image,
    encoding,
    chunks: normalizeChunks(value.chunks, encoding.size),
  });
}

export function serializeImageArtifactManifest(raw) {
  return `${JSON.stringify(normalizeImageArtifactManifest(raw))}\n`;
}

export function imageArtifactManifestDigest(raw) {
  return createHash('sha256').update(serializeImageArtifactManifest(raw), 'utf8').digest('hex');
}
