import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { RUNNER_SUBJECT_PROTOCOL, normalizeRunnerSubject, sameRunnerSubject } from './permanent-entry.mjs';

export const RUNNER_MANIFEST_PROTOCOL = 'devbridge/entry-runner-manifest-v1';
export const RUNNER_RELEASE_PROTOCOL = 'devbridge/entry-runner-release-v1';
export const RUNNER_REPOSITORY = 'iteathen/DevBridge';

const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

function fail(message) { throw new Error(message); }

function requireReadPort(value, name) {
  if (!value || typeof value.read !== 'function') throw new TypeError(`${name}.read must be a function`);
  return value;
}

function requireState(state) {
  for (const method of ['read', 'accept', 'fallback', 'preferred']) {
    if (!state || typeof state[method] !== 'function') throw new TypeError(`production stable authority state.${method} must be a function`);
  }
  return state;
}

function boundedBytes(value, name, limit) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > limit) fail(`${name} bytes are invalid`);
  return Buffer.from(value);
}

function boundedText(value, name, limit = 256) {
  const text = String(value ?? '');
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) fail(`${name} is invalid`);
  return text;
}

function normalizeRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('runner manifest release must be an object');
  const allowed = new Set(['repository', 'head', 'sha256', 'minimumEntryProtocol', 'channel', 'releaseId', 'sequence']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`runner manifest release.${key} is unsupported`);
  if (value.repository !== RUNNER_REPOSITORY) fail(`runner manifest repository must be ${RUNNER_REPOSITORY}`);
  if (value.channel !== 'stable') fail('runner manifest channel must be stable');
  const head = String(value.head ?? '').toLowerCase();
  const sha256 = String(value.sha256 ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head)) fail('runner manifest head must be an exact 40-hex commit');
  if (!EXACT_DIGEST.test(sha256)) fail('runner manifest sha256 must be an exact 64-hex digest');
  if (!Number.isSafeInteger(value.minimumEntryProtocol) || value.minimumEntryProtocol < 1) {
    fail('runner manifest minimum entry protocol is invalid');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('runner manifest sequence is invalid');
  return Object.freeze({
    repository: RUNNER_REPOSITORY,
    head,
    sha256,
    minimumEntryProtocol: value.minimumEntryProtocol,
    channel: 'stable',
    releaseId: boundedText(value.releaseId, 'runner manifest release identity'),
    sequence: value.sequence,
  });
}

export function runnerReleasePayload(release) {
  const normalized = normalizeRelease(release);
  return Buffer.from(JSON.stringify({
    protocol: RUNNER_RELEASE_PROTOCOL,
    repository: normalized.repository,
    head: normalized.head,
    sha256: normalized.sha256,
    minimumEntryProtocol: normalized.minimumEntryProtocol,
    channel: normalized.channel,
    releaseId: normalized.releaseId,
    sequence: normalized.sequence,
  }), 'utf8');
}

function normalizeSignature(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('runner manifest signature must be an object');
  const allowed = new Set(['algorithm', 'keyId', 'value']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`runner manifest signature.${key} is unsupported`);
  if (value.algorithm !== 'ed25519') fail('runner manifest signature algorithm must be ed25519');
  const keyId = boundedText(value.keyId, 'runner manifest key identity', 128);
  if (!KEY_ID.test(keyId)) fail('runner manifest key identity is invalid');
  if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.value)) {
    fail('runner manifest signature value must be bounded base64');
  }
  const bytes = Buffer.from(value.value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value.value) fail('runner manifest Ed25519 signature is invalid');
  return Object.freeze({ algorithm: 'ed25519', keyId, bytes });
}

function parseManifest(bytes) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('runner manifest is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('runner manifest must be an object');
  const allowed = new Set(['protocol', 'release', 'signature']);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) fail(`runner manifest field ${key} is unsupported`);
  if (parsed.protocol !== RUNNER_MANIFEST_PROTOCOL) fail('runner manifest protocol is unsupported');
  return { release: normalizeRelease(parsed.release), signature: normalizeSignature(parsed.signature) };
}

function verifyManifest(manifestBytes, publicKeyBytes) {
  const parsed = parseManifest(manifestBytes);
  let publicKey;
  try { publicKey = createPublicKey(publicKeyBytes); }
  catch { fail('runner manifest public key could not be parsed'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('runner manifest public key must be Ed25519');
  if (!verifySignature(null, runnerReleasePayload(parsed.release), publicKey, parsed.signature.bytes)) {
    fail('runner manifest signature verification failed');
  }
  const subject = normalizeRunnerSubject({
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head: parsed.release.head,
    sha256: parsed.release.sha256,
    minimumEntryProtocol: parsed.release.minimumEntryProtocol,
    channel: parsed.release.channel,
    releaseId: parsed.release.releaseId,
  });
  return Object.freeze({
    subject,
    sequence: parsed.release.sequence,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    keyId: parsed.signature.keyId,
  });
}

function key(subject) {
  const normalized = normalizeRunnerSubject(subject);
  return `${normalized.head}:${normalized.sha256}:${normalized.releaseId}`;
}

function productionRecord(state, subject) {
  if (!state) return null;
  for (const record of [state.current, state.previous]) {
    if (record?.mode === 'production' && sameRunnerSubject(record.subject, subject)) return record;
  }
  return null;
}

function preferredProductionRecord(state) {
  if (!state) return null;
  if (state.current.mode === 'production') return state.current;
  if (state.previous?.mode === 'production') return state.previous;
  return null;
}

function sameSignedAuthority(record, verified) {
  return sameRunnerSubject(record.subject, verified.subject) &&
    record.sequence === verified.sequence && record.manifestSha256 === verified.manifestSha256 && record.keyId === verified.keyId;
}

export class ProductionStableSubjectAuthority {
  #manifestSource;
  #publicKeySource;
  #state;
  #pending = new Map();

  constructor({ manifestSource, publicKeySource, state } = {}) {
    this.#manifestSource = requireReadPort(manifestSource, 'production stable manifest source');
    this.#publicKeySource = requireReadPort(publicKeySource, 'production stable public-key source');
    this.#state = requireState(state);
  }

  #remember(record, commit) {
    this.#pending.set(key(record.subject), { record, commit });
    return record.subject;
  }

  async resolve(selector) {
    if (!selector || selector.kind !== 'channel' || selector.value !== 'stable') {
      fail('production stable authority accepts only the stable channel selector');
    }
    const before = await this.#state.read();
    const accepted = preferredProductionRecord(before);
    let verified;
    try {
      const manifestBytes = boundedBytes(await this.#manifestSource.read(), 'runner manifest', MAX_MANIFEST_BYTES);
      const keyBytes = boundedBytes(await this.#publicKeySource.read(), 'runner public key', MAX_KEY_BYTES);
      verified = verifyManifest(manifestBytes, keyBytes);
    } catch (error) {
      if (!accepted) throw error;
      return this.#remember(accepted, false);
    }

    if (accepted) {
      if (verified.sequence < accepted.sequence) return this.#remember(accepted, false);
      if (verified.sequence === accepted.sequence) {
        if (!sameSignedAuthority(accepted, verified)) fail('runner manifest sequence conflicts with accepted production authority');
        return this.#remember(accepted, false);
      }
    }

    const existing = productionRecord(before, verified.subject);
    if (existing && existing.sequence > verified.sequence) return this.#remember(existing, false);
    const record = Object.freeze({
      subject: verified.subject,
      mode: 'production',
      sequence: verified.sequence,
      manifestSha256: verified.manifestSha256,
      keyId: verified.keyId,
      acceptedAt: new Date().toISOString(),
    });
    return this.#remember(record, true);
  }

  async recover(failedSubject) {
    const fallback = await this.#state.fallback(failedSubject, 'production');
    if (!fallback) return null;
    const state = await this.#state.read();
    const record = productionRecord(state, fallback);
    if (!record) fail('production stable fallback state changed during recovery');
    return this.#remember(record, false);
  }

  async accept(subject) {
    const pending = this.#pending.get(key(subject));
    if (!pending) {
      const state = await this.#state.read();
      if (state?.current?.mode === 'production' && sameRunnerSubject(state.current.subject, subject)) return state;
      fail('production stable runner acceptance has no matching signed evidence');
    }
    if (!pending.commit) return this.#state.read();
    return this.#state.accept(pending.record);
  }
}
