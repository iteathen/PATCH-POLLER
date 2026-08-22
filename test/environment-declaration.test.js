import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_DECLARATION_PROTOCOL,
  ENVIRONMENT_RECONSTRUCTABILITY,
  EnvironmentDeclarationRegistry,
  classifyEnvironmentReconstructability,
  logicalEnvironmentIdentity,
  normalizeEnvironmentDeclaration,
} from '../src/runtime/environment-declaration.js';

function declaration(overrides = {}) {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development',
    schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-2404-v1', generation: 'ubuntu-24.04.4-v1' },
    resources: { memoryBytes: 4 * 1024 * 1024 * 1024, processorCount: 4 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js', 'source-control'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
    workspaces: [{ identity: 'workspace-a', authority: 'authority-123' }],
    protectedStateClasses: [],
    ...overrides,
  };
}

function memoryPort() {
  const values = new Map();
  return {
    async load(key) { return structuredClone(values.get(key) ?? null); },
    async save(key, value) { values.set(key, structuredClone(value)); },
    async scan() { return [...values.values()].map((value) => structuredClone(value)); },
  };
}

test('logical environment identity is stable across replaceable declaration changes', () => {
  const first = declaration();
  const second = declaration({
    image: { identity: 'image-ubuntu-2404-v2', generation: 'ubuntu-24.04.4-v2' },
    resources: { memoryBytes: 8 * 1024 * 1024 * 1024, processorCount: 8 },
  });
  assert.equal(logicalEnvironmentIdentity(first.profile), logicalEnvironmentIdentity(second.profile));
  assert.notDeepEqual(normalizeEnvironmentDeclaration(first), normalizeEnvironmentDeclaration(second));
});

test('declaration rejects topology and implementation details outside its local contract', () => {
  assert.throws(() => normalizeEnvironmentDeclaration({ ...declaration(), diskPath: 'foreign' }), /diskPath is not allowed/u);
  assert.throws(() => normalizeEnvironmentDeclaration({ ...declaration(), guest: { ...declaration().guest, machineName: 'foreign' } }), /machineName is not allowed/u);
});

test('declaration requires boot and enrollment authority rather than implicit defaults', () => {
  assert.throws(() => normalizeEnvironmentDeclaration({ ...declaration(), boot: undefined }), /boot must be an object/u);
  assert.throws(() => normalizeEnvironmentDeclaration({ ...declaration(), enrollment: undefined }), /enrollment must be an object/u);
  assert.equal(normalizeEnvironmentDeclaration(declaration()).boot.requirement, 'efi-v1');
  assert.equal(normalizeEnvironmentDeclaration(declaration()).enrollment.requirement, 'unique-guest-trust-v1');
});

test('registry uses revision compare-and-swap for authority replacement', async () => {
  const registry = new EnvironmentDeclarationRegistry({ port: memoryPort(), now: () => '2026-08-22T07:00:00.000Z' });
  const first = await registry.register(declaration());
  assert.equal(first.changed, true);
  assert.equal(first.record.revision, 1);
  assert.equal((await registry.register(declaration())).changed, false);
  await assert.rejects(() => registry.register(declaration({ resources: { memoryBytes: 1, processorCount: 1 } })), /re-read/u);
  const second = await registry.register(declaration({ resources: { memoryBytes: 1, processorCount: 1 } }), { expectedRevision: 1 });
  assert.equal(second.record.revision, 2);
  assert.equal(second.record.identity, first.record.identity);
});

test('reconstructability classification never invents authority', () => {
  assert.equal(classifyEnvironmentReconstructability({ declaration: declaration() }), ENVIRONMENT_RECONSTRUCTABILITY.READY);
  assert.equal(classifyEnvironmentReconstructability({ authority: 'verified', completion: 'discoverable' }), ENVIRONMENT_RECONSTRUCTABILITY.DISCOVERY);
  assert.equal(classifyEnvironmentReconstructability({ authority: 'verified', completion: 'setup-required' }), ENVIRONMENT_RECONSTRUCTABILITY.SETUP);
  assert.equal(classifyEnvironmentReconstructability({ authority: 'ambiguous', completion: 'complete' }), ENVIRONMENT_RECONSTRUCTABILITY.UNSAFE);
});
