import { randomUUID } from 'node:crypto';
import { normalizeEnvironmentObservation } from './environment-observation.js';

export const ENVIRONMENT_LIFECYCLE_JOURNAL_PROTOCOL = 'devbridge/environment-lifecycle-journal-v1';
export const ENVIRONMENT_LIFECYCLE_STAGES = Object.freeze([
  'intent',
  'pre-observation',
  'fenced-attempt',
  'post-observation',
  'verification',
  'cleanup-reconciliation',
  'terminal',
]);
export const ENVIRONMENT_LIFECYCLE_OPERATIONS = Object.freeze(['create', 'repair', 'rebuild', 'reset', 'recreate']);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const TERMINAL_OUTCOMES = new Set(['complete', 'failed', 'ambiguous']);
const MAX_SUBJECTS = 256;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function operation(value) { if (!ENVIRONMENT_LIFECYCLE_OPERATIONS.includes(value)) throw new TypeError('environment lifecycle operation is invalid'); return value; }
function stage(value) { if (!ENVIRONMENT_LIFECYCLE_STAGES.includes(value)) throw new TypeError('environment lifecycle stage is invalid'); return value; }
function timestamp(value, name) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`); return value; }
function subjects(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_SUBJECTS) throw new TypeError('environment lifecycle subjects are invalid');
  const values = raw.map((value, index) => safeId(value, `environment lifecycle subjects[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError('environment lifecycle subjects contain duplicates');
  return Object.freeze(values);
}

function normalizeEntry(raw, index) {
  const value = requireObject(raw, `environment lifecycle entry[${index}]`);
  onlyKeys(value, new Set(['stage', 'at', 'outcome', 'fence', 'implementationGeneration', 'subjects', 'observation']), `environment lifecycle entry[${index}]`);
  const selectedStage = stage(value.stage);
  const outcome = safeId(value.outcome, `environment lifecycle entry[${index}].outcome`);
  if (selectedStage === 'terminal' && !TERMINAL_OUTCOMES.has(outcome)) throw new TypeError('terminal lifecycle entry outcome is invalid');
  if (selectedStage !== 'terminal' && TERMINAL_OUTCOMES.has(outcome)) throw new TypeError('nonterminal lifecycle entry cannot use a terminal outcome');
  return Object.freeze({
    stage: selectedStage,
    at: timestamp(value.at, `environment lifecycle entry[${index}].at`),
    outcome,
    fence: value.fence == null ? null : safeId(value.fence, `environment lifecycle entry[${index}].fence`),
    implementationGeneration: value.implementationGeneration == null ? null : safeId(value.implementationGeneration, `environment lifecycle entry[${index}].implementationGeneration`),
    subjects: subjects(value.subjects),
    observation: value.observation == null ? null : normalizeEnvironmentObservation(value.observation),
  });
}

export function normalizeEnvironmentLifecycleJournal(raw) {
  const value = requireObject(raw, 'environment lifecycle journal');
  onlyKeys(value, new Set(['protocol', 'environmentIdentity', 'operationId', 'operation', 'declarationRevision', 'entries']), 'environment lifecycle journal');
  if (value.protocol !== ENVIRONMENT_LIFECYCLE_JOURNAL_PROTOCOL) throw new TypeError('environment lifecycle journal protocol is unsupported');
  if (!Number.isSafeInteger(value.declarationRevision) || value.declarationRevision < 1) throw new TypeError('environment lifecycle declaration revision is invalid');
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > ENVIRONMENT_LIFECYCLE_STAGES.length) throw new TypeError('environment lifecycle journal entries are invalid');
  const environmentIdentity = safeId(value.environmentIdentity, 'environment lifecycle journal.environmentIdentity');
  const entries = value.entries.map(normalizeEntry);
  for (const entry of entries) {
    if (entry.observation && entry.observation.environmentIdentity !== environmentIdentity) throw new TypeError('environment lifecycle observation belongs to another environment');
    if (entry.observation && entry.observation.declarationRevision !== value.declarationRevision) throw new TypeError('environment lifecycle observation is stale for the journal declaration revision');
  }
  if (entries[0].stage !== 'intent') throw new TypeError('environment lifecycle journal must begin with intent');
  for (let index = 1; index < entries.length; index += 1) {
    const prior = ENVIRONMENT_LIFECYCLE_STAGES.indexOf(entries[index - 1].stage);
    const current = ENVIRONMENT_LIFECYCLE_STAGES.indexOf(entries[index].stage);
    if (current !== prior + 1) throw new TypeError('environment lifecycle journal stages must be contiguous');
  }
  return Object.freeze({
    protocol: ENVIRONMENT_LIFECYCLE_JOURNAL_PROTOCOL,
    environmentIdentity,
    operationId: safeId(value.operationId, 'environment lifecycle journal.operationId'),
    operation: operation(value.operation),
    declarationRevision: value.declarationRevision,
    entries: Object.freeze(entries),
  });
}

function isTerminal(record) { return record.entries.at(-1)?.stage === 'terminal'; }

export class EnvironmentLifecycleJournal {
  #port;
  #now;
  #id;

  constructor({ port, now = () => new Date().toISOString(), id = () => `lifecycle-${randomUUID()}` } = {}) {
    if (!port || typeof port.load !== 'function' || typeof port.save !== 'function' || typeof port.scan !== 'function') {
      throw new TypeError('environment lifecycle persistence port is incomplete');
    }
    if (typeof now !== 'function' || typeof id !== 'function') throw new TypeError('environment lifecycle dependencies are invalid');
    this.#port = port;
    this.#now = now;
    this.#id = id;
  }

  async current(environmentIdentity) {
    const raw = await this.#port.load(safeId(environmentIdentity, 'environment identity'));
    return raw == null ? null : normalizeEnvironmentLifecycleJournal(raw);
  }

  async active() {
    const values = await this.#port.scan();
    if (!Array.isArray(values)) throw new TypeError('environment lifecycle persistence scan is invalid');
    return Object.freeze(values.map(normalizeEnvironmentLifecycleJournal).filter((record) => !isTerminal(record)));
  }

  async begin({ environmentIdentity, operation: requestedOperation, declarationRevision }) {
    const identity = safeId(environmentIdentity, 'environment identity');
    const existing = await this.current(identity);
    if (existing && !isTerminal(existing)) throw new Error('environment already has an active lifecycle transition');
    if (!Number.isSafeInteger(declarationRevision) || declarationRevision < 1) throw new TypeError('environment declaration revision is invalid');
    const record = normalizeEnvironmentLifecycleJournal({
      protocol: ENVIRONMENT_LIFECYCLE_JOURNAL_PROTOCOL,
      environmentIdentity: identity,
      operationId: safeId(this.#id(), 'environment lifecycle operation identity'),
      operation: operation(requestedOperation),
      declarationRevision,
      entries: [{
        stage: 'intent', at: this.#now(), outcome: 'recorded', fence: null,
        implementationGeneration: null, subjects: [], observation: null,
      }],
    });
    await this.#port.save(identity, record);
    return record;
  }

  async advance(environmentIdentity, operationId, input) {
    const identity = safeId(environmentIdentity, 'environment identity');
    const current = await this.current(identity);
    if (!current) throw new Error('environment lifecycle transition does not exist');
    if (current.operationId !== safeId(operationId, 'environment lifecycle operation identity')) throw new Error('environment lifecycle operation identity does not match current transition');
    if (isTerminal(current)) throw new Error('environment lifecycle transition is already terminal');
    const nextStage = ENVIRONMENT_LIFECYCLE_STAGES[current.entries.length];
    const value = requireObject(input, 'environment lifecycle advance');
    onlyKeys(value, new Set(['stage', 'outcome', 'fence', 'implementationGeneration', 'subjects', 'observation']), 'environment lifecycle advance');
    if (value.stage !== nextStage) throw new Error(`environment lifecycle next stage must be ${nextStage}`);
    const next = normalizeEnvironmentLifecycleJournal({
      ...current,
      entries: [...current.entries, {
        stage: value.stage,
        at: this.#now(),
        outcome: value.outcome,
        fence: value.fence ?? null,
        implementationGeneration: value.implementationGeneration ?? null,
        subjects: value.subjects ?? [],
        observation: value.observation ?? null,
      }],
    });
    await this.#port.save(identity, next);
    return next;
  }
}
