import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, logicalEnvironmentIdentity } from '../src/runtime/environment-declaration.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';
import { EnvironmentConstructionPipeline } from '../src/runtime/environment-construction.js';

function declaration() {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development',
    schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-v1', generation: 'ubuntu-v1' },
    resources: { memoryBytes: 4294967296, processorCount: 4 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
    workspaces: [],
    protectedStateClasses: [],
  };
}

function checkpointPort() {
  const values = new Map();
  return {
    async load(key) { return structuredClone(values.get(key) ?? null); },
    async save(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
  };
}

test('construction resource preflight receives the declared profile', async () => {
  const selected = declaration();
  const environmentIdentity = logicalEnvironmentIdentity(selected.profile);
  const implementationGeneration = 'implementation-generation-1';
  let resourceRequest = null;
  const pipeline = new EnvironmentConstructionPipeline({
    checkpoint: checkpointPort(),
    image: { ensure: async () => ({ ready: true }) },
    resources: { ensure: async (request) => { resourceRequest = request; return { ready: true }; } },
    materialization: { ensure: async () => ({ ready: true, implementationGeneration }) },
    preparation: { ensure: async () => ({ ready: true, implementationGeneration }) },
    workspaces: { ensure: async () => ({ ready: true, implementationGeneration }) },
    readiness: {
      verify: async () => ({
        ready: true,
        implementationGeneration,
        observation: {
          protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
          environmentIdentity,
          declarationRevision: 1,
          implementationGeneration,
          materialization: 'present',
          systemStorage: 'present',
          attachment: 'ready',
          enrollment: 'ready',
          bootstrap: 'ready',
          guest: 'healthy',
          transition: 'clear',
        },
      }),
    },
  });

  await pipeline.run({ environmentIdentity, operationId: 'operation-profile-propagation', declarationRevision: 1, declaration: selected });
  assert.equal(resourceRequest.profile, selected.profile);
});
