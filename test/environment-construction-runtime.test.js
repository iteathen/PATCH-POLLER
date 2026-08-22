import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentConstructionRuntime } from '../src/app/environment-construction-runtime.js';

function foundation() {
  return {
    inspect: async () => ({ capabilities: { management: { ready: true } } }),
    ensureStorage: async () => ({ ready: true }),
    ensureNetwork: async () => ({ ready: true }),
    listEnvironments: async () => [],
    observeEnvironment: async () => null,
    ensureEnvironment: async () => { throw new Error('not expected during composition'); },
  };
}

test('production construction composition exposes one shared create pipeline without materializing on construction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-construction-runtime-'));
  try {
    const runtime = await createEnvironmentConstructionRuntime({
      stateDirectory: directory,
      availability: { ensure: async () => ({ state: 'local' }) },
      resolveAuthority: async () => '42',
      foundation: foundation(),
      invoke: async () => { throw new Error('not expected during composition'); },
    });
    assert.equal(typeof runtime.create, 'function');
    assert.equal(typeof runtime.pipeline.run, 'function');
    assert.equal(typeof runtime.lifecycle.declarations.register, 'function');
    assert.equal(typeof runtime.observer.observe, 'function');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
