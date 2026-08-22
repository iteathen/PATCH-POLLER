import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentLifecycle } from '../src/app/environment-lifecycle.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL } from '../src/runtime/environment-declaration.js';

function declaration() {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development', schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-2404-v1', generation: 'ubuntu-24.04.4-v1' },
    resources: { memoryBytes: 4294967296, processorCount: 4 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
    workspaces: [], protectedStateClasses: [],
  };
}

test('composition wires neutral lifecycle ports without exposing storage implementation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-lifecycle-app-'));
  try {
    const lifecycle = createEnvironmentLifecycle({
      stateDirectory: root,
      now: () => '2026-08-22T07:00:00.000Z',
      operationId: () => 'lifecycle-app-1',
    });
    const registered = await lifecycle.declarations.register(declaration());
    const transition = await lifecycle.journal.begin({
      environmentIdentity: registered.record.identity,
      operation: 'create',
      declarationRevision: registered.record.revision,
    });
    assert.equal(transition.operationId, 'lifecycle-app-1');
    assert.equal((await lifecycle.declarations.get(registered.record.identity)).revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
