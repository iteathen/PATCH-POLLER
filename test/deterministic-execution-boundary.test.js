import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { deterministicOperationSecurity } from '../src/runtime/deterministic-operation-security.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { REPOSITORY_EXECUTION_RESULT_PROTOCOL, REPOSITORY_EXECUTION_STATUS_PROTOCOL, normalizeRepositoryExecutionRequest } from '../src/runtime/repository-execution.js';

function fakeExecution(seen) {
  return {
    inspect() { return { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fake', reason: null }; },
    async execute(raw) {
      const req = normalizeRepositoryExecutionRequest(raw);
      seen.push(req);
      return { protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL, exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: 'repository-ok\n', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null, evidence: { identity: 'fake', scope: req.scope } };
    },
  };
}

test('operation security describes repository execution without sandbox vocabulary', () => {
  assert.deepEqual(deterministicOperationSecurity('node.syntax-check'), { executionClass: 'static-inspection', repositoryCode: false, repositoryExecutionRequired: false, executionRequirement: 'host-static' });
  assert.equal(deterministicOperationSecurity('node.test').repositoryExecutionRequired, true);
  assert.equal(deterministicOperationSecurity('future.package').executionRequirement, 'repository-execution');
  assert.equal(Object.hasOwn(deterministicOperationSecurity('node.test'), 'sandboxRequired'), false);
});

test('repository operation fails closed before host process launch when no repository executor exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-no-repository-exec-'));
  try {
    await writeFile(path.join(root, 'fixture.test.mjs'), "import test from 'node:test';test('x',()=>{});\n");
    const runner = new DeterministicProcessRunner({ sourceEnv: { PATH: process.env.PATH ?? '' } });
    await assert.rejects(() => createCoreOperationRegistry().execute('node.test', { paths: ['fixture.test.mjs'] }, { projectDir: root, processRunner: runner }), /no repository execution implementation/u);
    const syntax = await createCoreOperationRegistry().execute('node.syntax-check', { path: 'fixture.test.mjs' }, { projectDir: root, processRunner: runner });
    assert.equal(syntax.exitCode, 0);
    assert.equal(syntax.execution.location, 'host');
    assert.equal(syntax.execution.class, 'static-inspection');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fake repository executor attaches to deterministic flow through the same stud', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-fake-repository-exec-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'fixture.test.mjs'), "import test from 'node:test';test('x',()=>{});\n");
    await writeFile(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
    const seen = [];
    const runner = new DeterministicProcessRunner({ repositoryExecution: fakeExecution(seen) });
    const context = { projectDir: root, processRunner: runner, repository: 'owner/project', repositoryId: '7', runId: 'run-1' };
    const nodeResult = await createCoreOperationRegistry().execute('node.test', { paths: ['fixture.test.mjs'] }, context);
    assert.equal(nodeResult.execution.identity, 'fake');
    assert.equal(seen[0].invocation.tool, 'node');
    assert.deepEqual(seen[0].invocation.arguments.map((a) => a.value), ['--test', 'fixture.test.mjs']);
    assert.equal(seen[0].scope.repository, 'owner/project');

    await createCoreOperationRegistry().execute('cmake.configure', { sourcePath: 'CMakeLists.txt', buildId: 'b1' }, context);
    assert.equal(seen[1].invocation.tool, 'cmake');
    assert.deepEqual(seen[1].invocation.arguments, [
      { kind: 'literal', value: '-S' },
      { kind: 'literal', value: '.' },
      { kind: 'literal', value: '-B' },
      { kind: 'scratch', name: 'cmake-b1' },
    ]);
    assert.equal(seen[1].invocation.arguments.some((arg) => arg.kind === 'literal' && /(?:^|[\\/])scratch[\\/]/u.test(arg.value)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
