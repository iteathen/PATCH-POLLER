import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentMaterialization } from '../src/app/environment-materialization.js';

function request() {
  return {
    environmentIdentity: 'environment-0123456789abcdef0123456789abcdef',
    declarationRevision: 1,
    declaration: {
      profile: 'linux-development',
      image: { identity: 'img-0123456789abcdef0123456789abcdef' },
      resources: { memoryBytes: 4096, processorCount: 4 },
      boot: { requirement: 'efi-v1' },
    },
  };
}
function resolvers() {
  return {
    subject: { resolve: async () => 'profile-subject-1' },
    settings: { resolve: async () => ({ memoryBytes: 4096, processorCount: 4, firmware: 'efi' }) },
  };
}

test('materialization observes never-created state without inventing provider identity', async () => {
  const adapter = createEnvironmentMaterialization({ state: { listEnvironments: async () => [], ensureEnvironment: async () => { throw new Error('unused'); } }, ...resolvers() });
  const observed = await adapter.observe(request());
  assert.equal(observed.materialization, 'none');
  assert.equal(observed.implementationGeneration, null);
});

test('materialization creates through the existing lifecycle and returns only opaque generation', async () => {
  let supplied = null;
  const state = {
    listEnvironments: async () => [],
    ensureEnvironment: async (input) => {
      supplied = input;
      return { record: { identity: `env-${'1'.repeat(32)}` }, observation: { exists: true, owned: true, compatible: true } };
    },
  };
  const adapter = createEnvironmentMaterialization({ state, ...resolvers() });
  const result = await adapter.ensure(request());
  assert.equal(result.ready, true);
  assert.equal(result.implementationGeneration, `env-${'1'.repeat(32)}`);
  assert.deepEqual(supplied, {
    subject: 'profile-subject-1',
    profile: 'linux-development',
    sourceIdentity: 'img-0123456789abcdef0123456789abcdef',
    settings: { memoryBytes: 4096, processorCount: 4, firmware: 'efi' },
  });
});

test('materialization maps incompatible lineage to neutral invalid evidence', async () => {
  const state = {
    listEnvironments: async () => [{
      record: { identity: `env-${'2'.repeat(32)}`, subject: 'profile-subject-1', profile: 'linux-development' },
      observation: { exists: true, owned: true, compatible: false, storage: { sourceIdentity: 'img-other' } },
    }],
    ensureEnvironment: async () => { throw new Error('unused'); },
  };
  const adapter = createEnvironmentMaterialization({ state, ...resolvers() });
  const observed = await adapter.observe(request());
  assert.equal(observed.materialization, 'present');
  assert.equal(observed.systemStorage, 'invalid');
  assert.equal(observed.attachment, 'invalid');
});
