import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentConstructionObservation } from '../src/app/environment-construction-observation.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';

function request() {
  return {
    environmentIdentity: 'environment-1',
    declarationRevision: 2,
    declaration: {
      enrollment: { requirement: 'unique-guest-trust-v1' },
      bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
      workspaces: [],
    },
  };
}

function materialization(state = 'present') {
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: 'environment-1',
    declarationRevision: 2,
    implementationGeneration: state === 'present' ? 'implementation-1' : null,
    materialization: state,
    systemStorage: state === 'present' ? 'present' : 'unknown',
    attachment: state === 'present' ? 'ready' : 'unknown',
    enrollment: 'unknown',
    bootstrap: 'unknown',
    guest: 'unknown',
    transition: 'clear',
  };
}

test('construction observation becomes healthy only when preparation and workspaces are ready', async () => {
  const seen = [];
  const composed = createEnvironmentConstructionObservation({
    materialization: { observe: async () => materialization() },
    preparation: { inspect: async (input) => { seen.push(input); return { ready: true, enrollment: 'ready', bootstrap: 'ready' }; } },
    workspaces: { inspect: async (input) => { seen.push(input); return { ready: true }; } },
  });
  const observation = await composed.observe(request());
  assert.equal(observation.enrollment, 'ready');
  assert.equal(observation.bootstrap, 'ready');
  assert.equal(observation.guest, 'healthy');
  assert.equal(seen[0].implementationGeneration, 'implementation-1');
  assert.equal((await composed.readiness.verify(request())).ready, true);
});

test('construction observation never reports a missing materialization as guest healthy', async () => {
  let inspected = false;
  const composed = createEnvironmentConstructionObservation({
    materialization: { observe: async () => materialization('none') },
    preparation: { inspect: async () => { inspected = true; return { ready: true }; } },
    workspaces: { inspect: async () => { inspected = true; return { ready: true }; } },
  });
  const observation = await composed.observe(request());
  assert.equal(observation.materialization, 'none');
  assert.equal(observation.guest, 'unknown');
  assert.equal(inspected, false);
  await assert.rejects(() => composed.readiness.verify(request()), /not healthy/u);
});

test('workspace readiness loss degrades the final execution observation', async () => {
  const composed = createEnvironmentConstructionObservation({
    materialization: { observe: async () => materialization() },
    preparation: { inspect: async () => ({ ready: true, enrollment: 'ready', bootstrap: 'ready' }) },
    workspaces: { inspect: async () => ({ ready: false, reason: 'route unavailable' }) },
  });
  const observation = await composed.observe(request());
  assert.equal(observation.guest, 'degraded');
  await assert.rejects(() => composed.readiness.verify(request()), /not healthy/u);
});
