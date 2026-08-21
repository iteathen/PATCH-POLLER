import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  LocalToolchainRegistry,
  createCoreToolchainRegistry,
} from '../src/runtime/toolchain-registry.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';

test('core toolchain registry exposes locally resolved host-control tool names', () => {
  const registry = createCoreToolchainRegistry({ env: { PATH: '' } });
  assert.deepEqual(registry.names(), ['cmake', 'ctest', 'native.c', 'native.linker', 'node']);
});

test('local toolchain registry caches approved resolvers and reports unavailable tools without inventing authority', async () => {
  let calls = 0;
  const registry = new LocalToolchainRegistry()
    .register('fixture', async () => {
      calls += 1;
      return { executable: process.execPath, family: 'fixture', version: '1' };
    })
    .register('missing', async () => { throw new Error('not installed'); });
  assert.equal((await registry.resolve('fixture')).executable, process.execPath);
  assert.equal((await registry.resolve('fixture')).executable, process.execPath);
  assert.equal(calls, 1);
  const inspected = await registry.inspect();
  assert.equal(inspected.find((entry) => entry.name === 'fixture').available, true);
  assert.equal(inspected.find((entry) => entry.name === 'missing').available, false);
  await assert.rejects(() => registry.resolve('unregistered'), /unregistered local toolchain/u);
});

test('core operation registry removes generic node.run and exposes purpose-specific build/test operations', () => {
  const toolchains = new LocalToolchainRegistry()
    .register('node', async () => ({ executable: process.execPath }))
    .register('cmake', async () => ({ executable: '/local/cmake' }))
    .register('ctest', async () => ({ executable: '/local/ctest' }))
    .register('native.c', async () => ({ executable: '/local/cc' }))
    .register('native.linker', async () => ({ executable: '/local/ld' }));
  const registry = createCoreOperationRegistry({ toolchainRegistry: toolchains });
  assert.equal(registry.has('node.run'), false);
  assert.deepEqual(registry.names(), [
    'cmake.build',
    'cmake.configure',
    'ctest.run',
    'node.syntax-check',
    'node.test',
    'toolchain.probe',
  ]);
});

test('repository CMake operations derive only logical tool and environment-relative scratch arguments', async () => {
  const resolvingToolchains = new LocalToolchainRegistry()
    .register('cmake', async () => { throw new Error('repository CMake must not resolve a host executable'); })
    .register('ctest', async () => { throw new Error('repository CTest must not resolve a host executable'); });
  const registry = createCoreOperationRegistry({ toolchainRegistry: resolvingToolchains });
  const observed = [];
  const context = {
    projectDir: path.resolve('/project'),
    repository: 'owner/project',
    runId: 'run-1',
    processRunner: {
      run: async (request) => {
        observed.push(request);
        return { exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '' };
      },
    },
  };

  await registry.execute('cmake.configure', {
    sourcePath: 'CMakeLists.txt',
    buildId: 'release',
    buildType: 'Release',
    generator: 'Ninja',
  }, context);
  await registry.execute('cmake.build', { buildId: 'release', config: 'Release', target: 'all' }, context);
  await registry.execute('ctest.run', { buildId: 'release', config: 'Release' }, context);

  const scratch = { kind: 'scratch', name: 'cmake-release' };
  assert.equal(observed[0].repositoryTool, 'cmake');
  assert.deepEqual(observed[0].args, [
    '-S', '.', '-B', scratch, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
  ]);
  assert.equal(observed[1].repositoryTool, 'cmake');
  assert.deepEqual(observed[1].args, ['--build', scratch, '--config', 'Release', '--target', 'all']);
  assert.equal(observed[2].repositoryTool, 'ctest');
  assert.deepEqual(observed[2].args, ['--test-dir', scratch, '--output-on-failure', '-C', 'Release']);
  for (const entry of observed) {
    assert.equal(entry.executionClass, 'repository-code');
    assert.equal(entry.repository, 'owner/project');
    assert.equal(entry.runId, 'run-1');
    assert.equal(entry.args.some((arg) => typeof arg === 'string' && path.isAbsolute(arg)), false);
    assert.equal(entry.args.some((arg) => typeof arg === 'string' && /(?:^|[\\/])scratch[\\/]/u.test(arg)), false);
  }
  assert.throws(() => registry.validate('cmake.configure', { buildId: 'x', arguments: ['--trace'] }), /parameter arguments is not allowed/u);
});