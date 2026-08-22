import { createHash } from 'node:crypto';
import { RUNNER_SUBJECT_PROTOCOL } from './permanent-entry.mjs';

const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const MAX_RUNNER_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }

function requireSource(source) {
  if (!source || typeof source.resolve !== 'function' || typeof source.read !== 'function') {
    throw new TypeError('experimental subject authority requires resolve/read source ports');
  }
  return source;
}

function selector(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('experimental runner selector is invalid');
  for (const key of Object.keys(input)) if (!['kind', 'value'].includes(key)) fail(`experimental runner selector.${key} is not allowed`);
  if (!['ref', 'exact'].includes(input.kind) || typeof input.value !== 'string' || input.value.length === 0) {
    fail('experimental runner selector is invalid');
  }
  return { kind: input.kind, value: input.value };
}

function exactHead(value) {
  const head = String(value ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head)) fail('experimental runner did not resolve to an exact 40-hex commit');
  return head;
}

function runnerBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_RUNNER_BYTES) {
    fail('experimental runner artifact bytes are invalid');
  }
  return Buffer.from(value);
}

export class ExperimentalSubjectAuthority {
  #source;

  constructor({ source } = {}) {
    this.#source = requireSource(source);
  }

  async resolve(input) {
    const selected = selector(input);
    const head = selected.kind === 'exact'
      ? exactHead(selected.value)
      : exactHead(await this.#source.resolve(selected.value));
    const bytes = runnerBytes(await this.#source.read(head));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return Object.freeze({
      protocol: RUNNER_SUBJECT_PROTOCOL,
      head,
      sha256,
      minimumEntryProtocol: 1,
      channel: 'experimental',
      releaseId: `development-${head}`,
    });
  }
}
