import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_LIFECYCLE_STAGES,
  EnvironmentLifecycleJournal,
} from '../src/runtime/environment-lifecycle-journal.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';

function memoryPort() {
  const values = new Map();
  return {
    async load(key) { return structuredClone(values.get(key) ?? null); },
    async save(key, value) { values.set(key, structuredClone(value)); },
    async scan() { return [...values.values()].map((value) => structuredClone(value)); },
  };
}
function observation(declarationRevision = 1) {
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: 'environment-0123456789abcdef0123456789abcdef',
    declarationRevision,
    implementationGeneration: null,
    materialization: 'none', systemStorage: 'unknown', attachment: 'unknown', enrollment: 'unknown',
    bootstrap: 'unknown', guest: 'unknown', transition: 'clear',
  };
}

test('journal enforces contiguous restartable lifecycle stages', async () => {
  let tick = 0;
  const journal = new EnvironmentLifecycleJournal({
    port: memoryPort(),
    now: () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString(),
    id: () => 'lifecycle-fixed-1',
  });
  let record = await journal.begin({
    environmentIdentity: observation().environmentIdentity,
    operation: 'create',
    declarationRevision: 1,
  });
  assert.deepEqual(record.entries.map((entry) => entry.stage), ['intent']);
  await assert.rejects(() => journal.advance(record.environmentIdentity, record.operationId, { stage: 'verification', outcome: 'observed' }), /next stage/u);
  record = await journal.advance(record.environmentIdentity, record.operationId, { stage: 'pre-observation', outcome: 'observed', observation: observation() });
  record = await journal.advance(record.environmentIdentity, record.operationId, { stage: 'fenced-attempt', outcome: 'attempted', fence: 'fence-1', subjects: ['subject-1'] });
  record = await journal.advance(record.environmentIdentity, record.operationId, { stage: 'post-observation', outcome: 'observed', observation: { ...observation(), implementationGeneration: 'generation-1', materialization: 'present', systemStorage: 'present' } });
  record = await journal.advance(record.environmentIdentity, record.operationId, { stage: 'verification', outcome: 'verified', implementationGeneration: 'generation-1' });
  record = await journal.advance(record.environmentIdentity, record.operationId, { stage: 'cleanup-reconciliation', outcome: 'reconciled', subjects: ['subject-1'] });
  record = await journal.advance(record.environmentIdentity, record.operationId, { stage: 'terminal', outcome: 'complete', implementationGeneration: 'generation-1' });
  assert.deepEqual(record.entries.map((entry) => entry.stage), ENVIRONMENT_LIFECYCLE_STAGES);
  await assert.rejects(() => journal.advance(record.environmentIdentity, record.operationId, { stage: 'terminal', outcome: 'complete' }), /already terminal/u);
});

test('active scan exposes interrupted transitions without replaying them', async () => {
  const journal = new EnvironmentLifecycleJournal({ port: memoryPort(), id: () => 'lifecycle-fixed-2' });
  const record = await journal.begin({ environmentIdentity: observation().environmentIdentity, operation: 'rebuild', declarationRevision: 3 });
  await journal.advance(record.environmentIdentity, record.operationId, { stage: 'pre-observation', outcome: 'observed', observation: observation(3) });
  const active = await journal.active();
  assert.equal(active.length, 1);
  assert.equal(active[0].entries.at(-1).stage, 'pre-observation');
});

test('journal rejects observation from stale declaration authority', async () => {
  const journal = new EnvironmentLifecycleJournal({ port: memoryPort(), id: () => 'lifecycle-fixed-3' });
  const record = await journal.begin({ environmentIdentity: observation().environmentIdentity, operation: 'repair', declarationRevision: 2 });
  await assert.rejects(() => journal.advance(record.environmentIdentity, record.operationId, { stage: 'pre-observation', outcome: 'observed', observation: observation(1) }), /stale/u);
});
