import { createHash } from 'node:crypto';
import { RUNNER_SUBJECT_PROTOCOL, normalizeRunnerSubject, sameRunnerSubject } from './permanent-entry.mjs';

const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const MAX_RUNNER_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }

function requireSource(source) {
  if (!source || typeof source.resolve !== 'function' || typeof source.read !== 'function') {
    throw new TypeError('development stable authority requires resolve/read source ports');
  }
  return source;
}

function requireState(state) {
  for (const method of ['read', 'accept', 'fallback', 'preferred']) {
    if (!state || typeof state[method] !== 'function') throw new TypeError(`development stable authority state.${method} must be a function`);
  }
  return state;
}

function exactHead(value) {
  const head = String(value ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head)) fail('development stable runner did not resolve to an exact 40-hex commit');
  return head;
}

function runnerBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_RUNNER_BYTES) {
    fail('development stable runner artifact bytes are invalid');
  }
  return Buffer.from(value);
}

function key(subject) {
  const normalized = normalizeRunnerSubject(subject);
  return `${normalized.head}:${normalized.sha256}:${normalized.releaseId}`;
}

function currentRecord(state, subject) {
  if (!state) return null;
  if (sameRunnerSubject(state.current.subject, subject)) return state.current;
  if (state.previous && sameRunnerSubject(state.previous.subject, subject)) return state.previous;
  return null;
}

export class DevelopmentStableSubjectAuthority {
  #source;
  #state;
  #ref;
  #pending = new Map();

  constructor({ source, state, ref = 'main' } = {}) {
    this.#source = requireSource(source);
    this.#state = requireState(state);
    if (typeof ref !== 'string' || !ref || ref.length > 240) throw new TypeError('development stable ref must be bounded');
    this.#ref = ref;
  }

  #remember(record, commit) {
    this.#pending.set(key(record.subject), { record, commit });
    return record.subject;
  }

  async #acceptedDevelopment() {
    const subject = await this.#state.preferred('development');
    if (!subject) return null;
    const state = await this.#state.read();
    const record = currentRecord(state, subject);
    if (!record || record.mode !== 'development') fail('development stable state changed during selection');
    return record;
  }

  async resolve(selector) {
    if (!selector || selector.kind !== 'channel' || selector.value !== 'stable') {
      fail('development stable authority accepts only the stable channel selector');
    }

    const accepted = await this.#state.read();
    try {
      const head = exactHead(await this.#source.resolve(this.#ref));
      const bytes = runnerBytes(await this.#source.read(head));
      const subject = normalizeRunnerSubject({
        protocol: RUNNER_SUBJECT_PROTOCOL,
        head,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        minimumEntryProtocol: 1,
        channel: 'stable',
        releaseId: `development-${head}`,
      });
      const existing = currentRecord(accepted, subject);
      if (existing?.mode === 'development' && accepted && sameRunnerSubject(accepted.current.subject, subject)) {
        return this.#remember(existing, false);
      }
      const record = Object.freeze({
        subject,
        mode: 'development',
        sequence: null,
        manifestSha256: null,
        keyId: null,
        acceptedAt: new Date().toISOString(),
      });
      return this.#remember(record, true);
    } catch (error) {
      const fallback = await this.#acceptedDevelopment();
      if (!fallback) throw error;
      return this.#remember(fallback, false);
    }
  }

  async recover(failedSubject) {
    const fallback = await this.#state.fallback(failedSubject, 'development');
    if (!fallback) return null;
    const state = await this.#state.read();
    const record = currentRecord(state, fallback);
    if (!record || record.mode !== 'development') fail('development stable fallback state changed during recovery');
    return this.#remember(record, false);
  }

  async accept(subject) {
    const pending = this.#pending.get(key(subject));
    if (!pending) {
      const state = await this.#state.read();
      if (state?.current?.mode === 'development' && sameRunnerSubject(state.current.subject, subject)) return state;
      fail('development stable runner acceptance has no matching resolved evidence');
    }
    if (!pending.commit) return this.#state.read();
    return this.#state.accept(pending.record);
  }
}
