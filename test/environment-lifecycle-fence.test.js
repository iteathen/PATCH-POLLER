import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentLifecycleFence } from '../src/app/environment-lifecycle-fence.js';

test('lifecycle fence pauses active admission and resumes only its own pause', async () => {
  const events = [];
  const fence = createEnvironmentLifecycleFence({
    stateDirectory: '/state',
    pause: async (file) => { events.push(['pause', file]); return { activeLock: true, requested: true, alreadyRequested: false, paused: true }; },
    resume: async (file) => { events.push(['resume', file]); return { activeLock: true, resumed: true }; },
  });
  const held = await fence.acquire({ environmentIdentity: 'environment-1', operationId: 'operation-1' });
  assert.equal(held.subject, 'environment-1');
  await held.release();
  await held.release();
  assert.equal(events.filter(([kind]) => kind === 'resume').length, 1);
});

test('lifecycle fence preserves a pre-existing operator pause', async () => {
  let resumed = false;
  const fence = createEnvironmentLifecycleFence({
    stateDirectory: '/state',
    pause: async () => ({ activeLock: true, requested: true, alreadyRequested: true, paused: true }),
    resume: async () => { resumed = true; return { resumed: true }; },
  });
  const held = await fence.acquire({ environmentIdentity: 'environment-1', operationId: 'operation-1' });
  await held.release();
  assert.equal(resumed, false);
});

test('lifecycle fence fails closed until the daemon acknowledges the safe boundary', async () => {
  const fence = createEnvironmentLifecycleFence({
    stateDirectory: '/state',
    pause: async () => ({ activeLock: true, requested: true, alreadyRequested: false, paused: false }),
    resume: async () => ({ resumed: true }),
  });
  await assert.rejects(() => fence.acquire({ environmentIdentity: 'environment-1', operationId: 'operation-1' }), /safe boundary/u);
});
