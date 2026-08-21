import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  normalizeRepositoryExecutionRequest,
} from '../src/runtime/repository-execution.js';

function result() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: '',
    stderr: '',
    startedAt: null,
    finishedAt: null,
    lastOutputAt: null,
  };
}

test('CMake and CTest adapters pass only logical scratch references', async () => {
  const calls = [];
  const registry = createCoreOperationRegistry();
  const context = {
    projectDir: process.cwd(),
    repository: 'owner/repo',
    repositoryId: '123',
    runId: 'run-1',
    processRunner: { async run(request) { calls.push(request); return result(); } },
  };

  await registry.execute('cmake.configure', { sourcePath: 'CMakeLists.txt', buildId: 'native' }, context);
  await registry.execute('cmake.build', { buildId: 'native' }, context);
  await registry.execute('ctest.run', { buildId: 'native' }, context);

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.executionClass, 'repository-code');
    const references = call.args.filter((entry) => typeof entry === 'object');
    assert.deepEqual(references, [{ kind: 'scratch', name: 'cmake-native' }]);
    assert.equal(call.args.some((entry) => typeof entry === 'string' && /(?:^|[\\/])scratch[\\/]/u.test(entry)), false);
  }
  assert.equal(registry.executionClass('cmake.configure'), 'repository-code');
  assert.equal(registry.usesEnvironmentScratch('cmake.configure'), true);
  assert.equal(registry.usesEnvironmentScratch('cmake.build'), true);
  assert.equal(registry.usesEnvironmentScratch('ctest.run'), true);
  assert.equal(registry.usesEnvironmentScratch('node.test'), false);
});

test('repository execution admits bounded scratch identities without transfer authority', () => {
  const request = normalizeRepositoryExecutionRequest({
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: 'fixture.run',
    scope: { repository: 'owner/repo', repositoryId: '123', runId: 'run-1' },
    invocation: {
      tool: 'node',
      arguments: ['--output', { kind: 'scratch', name: 'build-native' }],
      workingDirectory: '.',
    },
    environment: { CI: '1' },
    transfers: [],
    limits: { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    stdin: null,
  });

  assert.deepEqual(request.invocation.arguments[1], { kind: 'scratch', name: 'build-native' });
  assert.throws(() => normalizeRepositoryExecutionRequest({
    ...request,
    invocation: { ...request.invocation, arguments: [{ kind: 'scratch', name: '../other-run' }] },
  }), /name is invalid/u);
  assert.throws(() => normalizeRepositoryExecutionRequest({
    ...request,
    invocation: { ...request.invocation, arguments: [{ kind: 'scratch', name: 'other/run' }] },
  }), /name is invalid/u);
});
