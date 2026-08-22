import { environmentObservationCondition, normalizeEnvironmentObservation } from './environment-observation.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function active(record) { return record != null && record.entries?.at(-1)?.stage !== 'terminal'; }
function lastStage(record) { return record.entries.at(-1).stage; }
function assertPort(value, methods, name) { if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment create ${name} contract is incomplete`); return value; }
function fenceEntry(record) { return record.entries.find((entry) => entry.stage === 'fenced-attempt') ?? null; }

export class EnvironmentCreate {
  #declarations; #journal; #observer; #fence; #construction;
  constructor({ declarations, journal, observer, fence, construction } = {}) {
    this.#declarations = assertPort(declarations, ['get'], 'declaration');
    this.#journal = assertPort(journal, ['current', 'begin', 'advance'], 'journal');
    this.#observer = assertPort(observer, ['observe'], 'observation');
    this.#fence = assertPort(fence, ['acquire'], 'fence');
    this.#construction = assertPort(construction, ['run', 'clear'], 'construction');
  }

  async #observe(record) {
    const value = normalizeEnvironmentObservation(await this.#observer.observe(Object.freeze({
      environmentIdentity: record.identity,
      declarationRevision: record.revision,
      declaration: record.declaration,
    })));
    if (value.environmentIdentity !== record.identity || value.declarationRevision !== record.revision) throw new Error('environment create observation does not match declaration authority');
    return value;
  }

  async #acquireFence(record) {
    const held = await this.#fence.acquire(Object.freeze({ environmentIdentity: record.environmentIdentity, operationId: record.operationId }));
    if (!held || typeof held.release !== 'function') throw new Error('environment create fence did not return a release contract');
    const subject = safeId(held.subject, 'environment create fence subject');
    const prior = fenceEntry(record)?.fence ?? null;
    if (prior != null && subject !== prior) {
      await held.release();
      throw new Error('environment create fence subject changed during resume');
    }
    return { held, subject };
  }

  async create(rawIdentity) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    let record = await this.#journal.current(identity);
    if (active(record)) {
      if (record.operation !== 'create') throw new Error('another lifecycle operation is active for the environment');
      if (record.declarationRevision !== declaration.revision) throw new Error('active environment create no longer matches declaration authority');
    } else {
      const before = await this.#observe(declaration);
      if (environmentObservationCondition(before) !== 'materialization-not-created') throw new Error('environment create refuses to overwrite an existing or ambiguous materialization');
      record = await this.#journal.begin({ environmentIdentity: identity, operation: 'create', declarationRevision: declaration.revision });
    }

    let held = null;
    try {
      if (lastStage(record) === 'intent') {
        const before = await this.#observe(declaration);
        if (environmentObservationCondition(before) !== 'materialization-not-created') throw new Error('environment create pre-observation no longer permits creation');
        record = await this.#journal.advance(identity, record.operationId, { stage: 'pre-observation', outcome: 'observed', observation: before });
      }

      if (lastStage(record) === 'pre-observation') {
        const acquired = await this.#acquireFence(record);
        held = acquired.held;
        record = await this.#journal.advance(identity, record.operationId, { stage: 'fenced-attempt', outcome: 'attempted', fence: acquired.subject });
      } else if (['fenced-attempt', 'post-observation', 'verification'].includes(lastStage(record))) {
        held = (await this.#acquireFence(record)).held;
      }

      if (lastStage(record) === 'fenced-attempt') {
        const result = await this.#construction.run({ environmentIdentity: identity, operationId: record.operationId, declarationRevision: declaration.revision, declaration: declaration.declaration });
        const after = await this.#observe(declaration);
        if (after.implementationGeneration !== result.implementationGeneration) throw new Error('environment create post-observation generation changed');
        record = await this.#journal.advance(identity, record.operationId, { stage: 'post-observation', outcome: 'observed', implementationGeneration: result.implementationGeneration, observation: after });
      }

      if (lastStage(record) === 'post-observation') {
        const verified = await this.#observe(declaration);
        if (environmentObservationCondition(verified) !== 'healthy') throw new Error('environment create verification did not observe a healthy environment');
        const expected = record.entries.at(-1).implementationGeneration;
        if (verified.implementationGeneration !== expected) throw new Error('environment create verification generation changed');
        record = await this.#journal.advance(identity, record.operationId, { stage: 'verification', outcome: 'verified', implementationGeneration: expected, observation: verified });
      }

      if (lastStage(record) === 'verification') {
        await this.#construction.clear(record.operationId);
        record = await this.#journal.advance(identity, record.operationId, { stage: 'cleanup-reconciliation', outcome: 'reconciled', implementationGeneration: record.entries.at(-1).implementationGeneration });
      }

      if (lastStage(record) === 'cleanup-reconciliation') {
        record = await this.#journal.advance(identity, record.operationId, { stage: 'terminal', outcome: 'complete', implementationGeneration: record.entries.at(-1).implementationGeneration });
      }

      const terminal = record.entries.at(-1);
      return Object.freeze({ state: terminal.outcome, environmentIdentity: identity, operationId: record.operationId, implementationGeneration: terminal.implementationGeneration });
    } finally {
      await held?.release();
    }
  }
}
