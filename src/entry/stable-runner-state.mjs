import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRunnerSubject, sameRunnerSubject } from './permanent-entry.mjs';

export const STABLE_RUNNER_STATE_PROTOCOL = 'devbridge/entry-stable-state-v1';

const MAX_STATE_BYTES = 32 * 1024;
const MAX_REVISIONS = 100_000;
const DIGEST = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const REVISION_FILE = /^(\d{12})\.json$/u;
const TEMP_FILE = /^\.stable-state\.[0-9a-f-]{36}\.tmp$/iu;

function fail(message) { throw new Error(message); }

function boundedText(value, name, limit = 256) {
  const text = String(value ?? '');
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) fail(`${name} is invalid`);
  return text;
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('stable runner record is invalid');
  const allowed = new Set(['subject', 'mode', 'sequence', 'manifestSha256', 'keyId', 'acceptedAt']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`stable runner record.${key} is unsupported`);
  const mode = input.mode;
  if (!['development', 'production'].includes(mode)) fail('stable runner record mode is invalid');
  let sequence = null;
  let manifestSha256 = null;
  let keyId = null;
  if (mode === 'production') {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) fail('stable production runner sequence is invalid');
    sequence = input.sequence;
    manifestSha256 = String(input.manifestSha256 ?? '').toLowerCase();
    if (!DIGEST.test(manifestSha256)) fail('stable production manifest digest is invalid');
    keyId = boundedText(input.keyId, 'stable production key identity', 128);
    if (!KEY_ID.test(keyId)) fail('stable production key identity is invalid');
  } else if (input.sequence != null || input.manifestSha256 != null || input.keyId != null) {
    fail('stable development runner record cannot carry production evidence');
  }
  const acceptedAt = boundedText(input.acceptedAt, 'stable runner accepted time', 64);
  if (!Number.isFinite(Date.parse(acceptedAt))) fail('stable runner accepted time is invalid');
  return Object.freeze({
    subject: normalizeRunnerSubject(input.subject),
    mode,
    sequence,
    manifestSha256,
    keyId,
    acceptedAt,
  });
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('stable runner state is invalid');
  const allowed = new Set(['protocol', 'revision', 'current', 'previous']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`stable runner state.${key} is unsupported`);
  if (input.protocol !== STABLE_RUNNER_STATE_PROTOCOL) fail('stable runner state protocol is unsupported');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > MAX_REVISIONS) {
    fail('stable runner state revision is invalid');
  }
  return Object.freeze({
    protocol: STABLE_RUNNER_STATE_PROTOCOL,
    revision: input.revision,
    current: normalizeRecord(input.current),
    previous: input.previous == null ? null : normalizeRecord(input.previous),
  });
}

function sameRecord(left, right) {
  if (left == null || right == null) return left === right;
  return sameRunnerSubject(left.subject, right.subject) &&
    left.mode === right.mode &&
    left.sequence === right.sequence &&
    left.manifestSha256 === right.manifestSha256 &&
    left.keyId === right.keyId &&
    left.acceptedAt === right.acceptedAt;
}

async function ensureRealDirectory(directory, name = 'stable runner state directory') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory`);
  return realpath(directory);
}

function revisionName(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISIONS) fail('stable runner revision is out of range');
  return `${String(revision).padStart(12, '0')}.json`;
}

async function readStateFile(file, expectedRevision) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_STATE_BYTES) {
    fail('stable runner state file is invalid');
  }
  const bytes = await readFile(file);
  if (bytes.length < 1 || bytes.length > MAX_STATE_BYTES) fail('stable runner state file is invalid');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('stable runner state is not valid JSON'); }
  const state = normalizeState(parsed);
  if (state.revision !== expectedRevision) fail('stable runner state revision does not match its immutable journal identity');
  return state;
}

async function readJournal(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const revisions = [];
  for (const entry of entries) {
    if (entry.isFile() && TEMP_FILE.test(entry.name)) continue;
    const matched = entry.isFile() ? entry.name.match(REVISION_FILE) : null;
    if (!matched) fail(`stable runner state contains an unsupported entry: ${entry.name}`);
    const revision = Number.parseInt(matched[1], 10);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISIONS) fail('stable runner journal revision is invalid');
    revisions.push(revision);
  }
  revisions.sort((left, right) => left - right);
  for (let index = 0; index < revisions.length; index += 1) {
    if (revisions[index] !== index + 1) fail('stable runner state journal has a missing or duplicate revision');
  }
  if (revisions.length === 0) return null;
  const revision = revisions.at(-1);
  return readStateFile(path.join(directory, revisionName(revision)), revision);
}

function sameAuthority(left, right) {
  return sameRunnerSubject(left.subject, right.subject) &&
    left.mode === right.mode && left.sequence === right.sequence &&
    left.manifestSha256 === right.manifestSha256 && left.keyId === right.keyId;
}

function enforceProductionSequence(before, record) {
  if (record.mode !== 'production' || before?.current?.mode !== 'production') return;
  if (record.sequence < before.current.sequence) fail('stable production runner manifest sequence would roll back accepted authority');
  if (record.sequence === before.current.sequence && !sameAuthority(before.current, record)) {
    fail('stable production runner manifest sequence conflicts with accepted authority');
  }
}

export class StableRunnerState {
  #root;

  constructor({ stateRoot } = {}) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
      throw new TypeError('stable runner stateRoot must be an absolute local path');
    }
    this.#root = path.resolve(stateRoot);
  }

  async #journal() {
    const root = await ensureRealDirectory(this.#root, 'stable runner state root');
    return ensureRealDirectory(path.join(root, 'stable'), 'stable runner journal');
  }

  async read() {
    return readJournal(await this.#journal());
  }

  async accept(input) {
    const record = normalizeRecord(input);
    const directory = await this.#journal();

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const before = await readJournal(directory);
      if (before && sameAuthority(before.current, record)) return before;
      enforceProductionSequence(before, record);
      const revision = (before?.revision ?? 0) + 1;
      if (revision > MAX_REVISIONS) fail('stable runner state journal reached its bounded revision limit');
      const next = normalizeState({
        protocol: STABLE_RUNNER_STATE_PROTOCOL,
        revision,
        current: record,
        previous: before?.current ?? null,
      });
      const temporary = path.join(directory, `.stable-state.${randomUUID()}.tmp`);
      const target = path.join(directory, revisionName(revision));
      let handle = null;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        try {
          await link(temporary, target);
        } catch (error) {
          if (error?.code === 'EEXIST') continue;
          throw error;
        }
      } finally {
        if (handle) { try { await handle.close(); } catch {} }
        await rm(temporary, { force: true }).catch(() => {});
      }

      const observed = await readJournal(directory);
      if (!observed || observed.revision < revision) fail('stable runner state publication became indeterminate');
      if (!sameAuthority(observed.current, record)) {
        fail('stable runner acceptance was superseded concurrently; refusing to launch stale authority');
      }
      return observed;
    }
    fail('stable runner state changed continuously during bounded acceptance');
  }

  async preferred(mode) {
    if (!['development', 'production'].includes(mode)) throw new TypeError('stable runner preferred mode is invalid');
    const state = await this.read();
    if (!state) return null;
    if (state.current.mode === mode) return state.current.subject;
    if (state.previous?.mode === mode) return state.previous.subject;
    return null;
  }

  async fallback(failedSubject, mode = null) {
    const failed = normalizeRunnerSubject(failedSubject);
    if (mode != null && !['development', 'production'].includes(mode)) throw new TypeError('stable runner fallback mode is invalid');
    const state = await this.read();
    if (!state) return null;
    for (const record of [state.current, state.previous]) {
      if (!record || (mode != null && record.mode !== mode)) continue;
      if (!sameRunnerSubject(record.subject, failed)) return record.subject;
    }
    return null;
  }

  async status() {
    const state = await this.read();
    if (!state) return Object.freeze({ configured: false, revision: 0, current: null, previous: null });
    const project = (record) => record == null ? null : Object.freeze({
      subject: record.subject,
      mode: record.mode,
      sequence: record.sequence,
      manifestSha256: record.manifestSha256,
      keyId: record.keyId,
      acceptedAt: record.acceptedAt,
    });
    return Object.freeze({
      configured: true,
      revision: state.revision,
      current: project(state.current),
      previous: project(state.previous),
    });
  }
}
