import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/u;
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function headers(token, accept = 'application/vnd.github+json') {
  const value = { Accept: accept, 'User-Agent': 'DevBridge-image-source', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}
function exactSize(raw, name) { if (!Number.isSafeInteger(raw) || raw < 1) throw new TypeError(`${name} is invalid`); return raw; }
function byteLimit(expected) {
  let observed = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      observed += chunk.length;
      if (observed > expected) callback(new Error('release source object exceeded its declared byte bound'));
      else callback(null, chunk);
    },
    flush(callback) {
      if (observed !== expected) callback(new Error('release source object length did not match its declared byte bound'));
      else callback();
    },
  });
}

export class GitHubReleaseImageSource {
  #owner; #repository; #releaseId; #manifestAsset; #manifestDigest; #token; #fetch; #cachedRelease = null;
  constructor({ owner, repository, releaseId, manifestAsset, manifestDigest, token = () => null, fetchImpl = globalThis.fetch } = {}) {
    if (typeof owner !== 'string' || !SAFE_OWNER.test(owner)) throw new TypeError('release source owner is invalid');
    if (typeof repository !== 'string' || !SAFE_REPOSITORY.test(repository)) throw new TypeError('release source repository is invalid');
    if (!Number.isSafeInteger(releaseId) || releaseId < 1) throw new TypeError('release source identity is invalid');
    if (typeof manifestAsset !== 'string' || !SAFE_LEAF.test(manifestAsset)) throw new TypeError('release source manifest asset is invalid');
    const normalizedDigest = String(manifestDigest ?? '').toLowerCase();
    if (!DIGEST.test(normalizedDigest)) throw new TypeError('release source manifest digest is invalid');
    if (typeof token !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('release source dependencies are invalid');
    this.#owner = owner; this.#repository = repository; this.#releaseId = releaseId; this.#manifestAsset = manifestAsset; this.#manifestDigest = normalizedDigest; this.#token = token; this.#fetch = fetchImpl;
  }
  async #release() {
    if (this.#cachedRelease) return this.#cachedRelease;
    const token = await this.#token();
    const response = await this.#fetch(`https://api.github.com/repos/${this.#owner}/${this.#repository}/releases/${this.#releaseId}`, { headers: headers(token) });
    if (!response.ok) throw new Error(`release source metadata request failed: ${response.status}`);
    const value = await response.json();
    if (value?.id !== this.#releaseId || !Array.isArray(value.assets)) throw new Error('release source metadata does not match the configured immutable subject');
    this.#cachedRelease = value;
    return value;
  }
  async #asset(name) {
    if (typeof name !== 'string' || !SAFE_LEAF.test(name)) throw new TypeError('release source object name is invalid');
    const release = await this.#release();
    const matches = release.assets.filter((asset) => asset?.name === name && Number.isSafeInteger(asset?.id) && asset.id > 0 && typeof asset.url === 'string');
    if (matches.length !== 1) throw new Error(`release source object is not unique: ${name}`);
    const asset = matches[0];
    const expected = `https://api.github.com/repos/${this.#owner}/${this.#repository}/releases/assets/${asset.id}`;
    if (asset.url !== expected) throw new Error('release source object API identity does not match local source policy');
    return asset;
  }
  async #response(asset) {
    const token = await this.#token();
    const response = await this.#fetch(asset.url, { headers: headers(token, 'application/octet-stream'), redirect: 'follow' });
    if (!response.ok) throw new Error(`release source object request failed: ${response.status}`);
    return response;
  }
  async manifest() {
    const asset = await this.#asset(this.#manifestAsset);
    const response = await this.#response(asset);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) throw new Error('release source manifest exceeds its byte bound');
    if (!response.body) throw new Error('release source manifest has no response body');
    const chunks = [];
    let observed = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      observed += chunk.length;
      if (observed > MAX_MANIFEST_BYTES) throw new Error('release source manifest exceeds its byte bound');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, observed);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== this.#manifestDigest) throw new Error('release source manifest digest does not match local source policy');
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('release source manifest is invalid JSON'); }
    return Object.freeze({ manifest, digest });
  }
  async fetch({ name, destination, size }) {
    const expected = exactSize(size, 'release source object size');
    const asset = await this.#asset(name);
    if (Number.isSafeInteger(asset.size) && asset.size !== expected) throw new Error('release source metadata object size does not match the manifest');
    const response = await this.#response(asset);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength !== expected) throw new Error('release source response length does not match the manifest');
    if (!response.body) throw new Error('release source object has no response body');
    try { await pipeline(Readable.fromWeb(response.body), byteLimit(expected), createWriteStream(destination, { flags: 'wx', mode: 0o600 })); }
    catch (error) { await rm(destination, { force: true }).catch(() => {}); throw error; }
  }
}
