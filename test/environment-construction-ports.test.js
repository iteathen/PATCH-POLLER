import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentImagePort, createEnvironmentResourcePort } from '../src/app/environment-construction-ports.js';
import { createEnvironmentMaterializationPolicy } from '../src/app/environment-materialization-policy.js';

test('image construction port asks only for the exact declared semantic image', async () => {
  let request = null;
  const port = createEnvironmentImagePort({ availability: { ensure: async (input) => { request = input; return { state: 'reconstructed' }; } } });
  assert.deepEqual(await port.ensure({ image: { identity: 'img-1', generation: 'generation-1' } }), { ready: true });
  assert.deepEqual(request, { identity: 'img-1', generation: 'generation-1' });
});

test('resource construction port verifies policy before preparing shared resources', async () => {
  const events = [];
  const port = createEnvironmentResourcePort({
    settings: { resolve: async () => { events.push('settings'); return { firmware: 'efi' }; } },
    state: {
      inspect: async () => { events.push('inspect'); return { capabilities: { management: { ready: true } } }; },
      ensureStorage: async () => { events.push('storage'); return { ready: true }; },
      ensureNetwork: async () => { events.push('network'); return { ready: true }; },
    },
  });
  assert.deepEqual(await port.ensure({ profile: 'p', resources: { memoryBytes: 1, processorCount: 1 }, boot: { requirement: 'efi-v1' }, network: { requirement: 'managed-v1' } }), { ready: true });
  assert.deepEqual(events, ['settings', 'inspect', 'storage', 'network']);
});

test('initial materialization policy supports the declared EFI contract without provider identity', async () => {
  const policy = createEnvironmentMaterializationPolicy();
  assert.match(await policy.subject.resolve({ profile: 'linux-development' }), /^profile-[a-f0-9]{32}$/u);
  assert.deepEqual(await policy.settings.resolve({ resources: { memoryBytes: 4096, processorCount: 4 }, boot: { requirement: 'efi-v1' } }), { memoryBytes: 4096, processorCount: 4, firmware: 'efi' });
  await assert.rejects(() => policy.settings.resolve({ resources: { memoryBytes: 4096, processorCount: 4 }, boot: { requirement: 'unknown-v1' } }), /unsupported/u);
});
