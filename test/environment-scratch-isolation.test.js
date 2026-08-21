import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRepositoryExecution, ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL } from '../src/app/repository-execution.js';
import { REPOSITORY_EXECUTION_REQUEST_PROTOCOL } from '../src/runtime/repository-execution.js';

async function command(program, args, { cwd, input = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ exitCode: code, signal, stdout, stderr }));
    if (input == null) child.stdin.end(); else child.stdin.end(input);
  });
}

async function initGit(root) {
  await command('git', ['init', '-q'], { cwd: root });
  await command('git', ['config', 'user.name', 'Host'], { cwd: root });
  await command('git', ['config', 'user.email', 'host@localhost'], { cwd: root });
  await command('git', ['add', '-A'], { cwd: root });
  await command('git', ['commit', '-q', '-m', 'base'], { cwd: root });
}

async function visible(root) {
  const result = await command('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}

function localChannel(root) {
  const classes = {};
  for (const name of ['input', 'work', 'output', 'cache', 'scratch']) classes[name] = path.join(root, name);
  const ensure = async () => { for (const directory of Object.values(classes)) await mkdir(directory, { recursive: true }); };
  const locate = async (location, { forInput = false } = {}) => {
    await ensure();
    const candidate = path.join(classes[location.class], ...location.path.split('/').filter((part) => part !== '.'));
    if (!forInput) await mkdir(path.dirname(candidate), { recursive: true });
    return candidate;
  };
  return {
    classes,
    async health() { await ensure(); return { ready: true, version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'], reason: null }; },
    async put(_target, source, destination, { maxBytes = 32 * 1024 * 1024 } = {}) {
      const file = await locate(destination);
      let offset = 0;
      const chunks = [];
      while (true) {
        const part = await source.read({ offset, limit: Math.min(16 * 1024, maxBytes - offset) });
        const data = Buffer.from(part.data);
        chunks.push(data);
        offset += data.length;
        if (part.eof) break;
        if (offset >= maxBytes) throw new Error('put limit');
      }
      await writeFile(file, Buffer.concat(chunks));
      return { bytes: offset, digest: 'x' };
    },
    async get(_target, source, sink, { maxBytes = 32 * 1024 * 1024 } = {}) {
      const file = await locate(source, { forInput: true });
      const data = await readFile(file);
      if (data.length > maxBytes) throw new Error('get limit');
      await sink.write({ offset: 0, data, eof: true, digest: 'x' });
      return { bytes: data.length, digest: 'x' };
    },
    async execute(_target, operation, { signal = null, onActivity = null } = {}) {
      await ensure();
      const args = [];
      for (const argument of operation.arguments) {
        if (typeof argument === 'string') args.push(argument);
        else args.push(await locate(argument, { forInput: argument.class === 'input' }));
      }
      const cwd = operation.directory.path === '.' ? classes[operation.directory.class] : await locate(operation.directory);
      onActivity?.({ state: 'running' });
      if (signal?.aborted) {
        return { completion: 'observed', result: { exitCode: null, signal: null, timedOut: false, aborted: true, outputTruncated: false, stdout: '', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null } };
      }
      const startedAt = new Date().toISOString();
      const result = await command(operation.program, args, { cwd, input: operation.input, env: { ...process.env, ...operation.environment } });
      const finishedAt = new Date().toISOString();
      return {
        completion: 'observed',
        result: {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: result.stdout,
          stderr: result.stderr,
          startedAt,
          finishedAt,
          lastOutputAt: result.stdout || result.stderr ? finishedAt : null,
        },
      };
    },
  };
}

function request(args, runId) {
  return {
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: 'fixture.scratch',
    scope: { repository: 'owner/repo', repositoryId: '123', runId },
    invocation: { tool: 'node', arguments: args, workingDirectory: '.' },
    environment: { CI: '1' },
    transfers: [],
    limits: { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
    stdin: null,
    signal: null,
    onActivity: null,
  };
}

async function missing(candidate) {
  try { await lstat(candidate); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

test('environment scratch persists across operations, stays out of candidate transfer, and cleans exact run ownership', { skip: process.platform === 'win32' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-environment-scratch-'));
  const host = path.join(temp, 'host');
  const guest = path.join(temp, 'guest');
  try {
    await mkdir(host);
    await writeFile(path.join(host, 'a.txt'), 'alpha\n');
    await initGit(host);
    const entry = {
      record: { identity: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: '123', profile: 'shared' },
      observation: { exists: true, owned: true, compatible: true, state: 'running' },
    };
    const state = {
      inspect: async () => ({ ready: true, identity: 'f'.repeat(32), reason: null }),
      listEnvironments: async () => [entry],
      observeEnvironment: async () => entry,
    };
    const channel = localChannel(guest);
    const execution = await createRepositoryExecution({
      stateDirectory: path.join(temp, 'state'),
      platform: 'linux',
      routes: { protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL, routes: [{ subject: '123', profile: 'shared', preferred: true, access: { family: 'linux' } }] },
      rootFor: async () => host,
      listPaths: async (root) => visible(root),
      resolveSubject: async () => '123',
      resolveTool: async (tool) => ({ program: tool, arguments: [] }),
      createState: async () => state,
      createPreparation: async () => ({ ensure: async () => ({ generation: 'b'.repeat(64) }), connection: async () => ({ family: 'linux' }) }),
      createChannel: async () => channel,
    });

    const createScript = `const fs=require('node:fs');const path=require('node:path');const root=process.argv[1];fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'mode.sh'),'#!/bin/sh\\n',{mode:0o755});fs.symlinkSync('mode.sh',path.join(root,'link'));process.stdout.write(root.endsWith('native')?'created':'bad');`;
    const first = await execution.execute(request(['-e', createScript, { kind: 'scratch', name: 'native' }], 'run-1'));
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(first.stdout, 'created');
    assert.equal(JSON.stringify(first).includes(guest), false);

    const runOne = path.join(channel.classes.scratch, 'subjects', '123', 'runs', 'run-1', 'native');
    const executable = await lstat(path.join(runOne, 'mode.sh'));
    assert.notEqual(executable.mode & 0o111, 0);
    assert.equal((await lstat(path.join(runOne, 'link'))).isSymbolicLink(), true);
    assert.equal(await missing(path.join(host, 'subjects')), true);

    const observeScript = `const fs=require('node:fs');const path=require('node:path');const root=process.argv[1];process.stdout.write(String((fs.statSync(path.join(root,'mode.sh')).mode&0o111)!==0)+'|'+fs.lstatSync(path.join(root,'link')).isSymbolicLink());`;
    const observed = await execution.execute(request(['-e', observeScript, { kind: 'scratch', name: 'native' }], 'run-1'));
    assert.equal(observed.stdout, 'true|true');

    const secondScript = `const fs=require('node:fs');const path=require('node:path');const root=process.argv[1];fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'marker'),'run-2');`;
    await execution.execute(request(['-e', secondScript, { kind: 'scratch', name: 'native' }], 'run-2'));
    const runTwoRoot = path.join(channel.classes.scratch, 'subjects', '123', 'runs', 'run-2');

    const cleaned = await execution.cleanup({ scope: { repository: 'owner/repo', repositoryId: '123', runId: 'run-1' }, resource: 'scratch' });
    assert.equal(cleaned.state, 'verified-absent');
    assert.equal(cleaned.removed, true);
    assert.equal(JSON.stringify(cleaned).includes(guest), false);
    assert.equal(await missing(path.join(channel.classes.scratch, 'subjects', '123', 'runs', 'run-1')), true);
    assert.equal(await readFile(path.join(runTwoRoot, 'native', 'marker'), 'utf8'), 'run-2');

    const repeated = await execution.cleanup({ scope: { repository: 'owner/repo', repositoryId: '123', runId: 'run-1' }, resource: 'scratch' });
    assert.equal(repeated.state, 'verified-absent');
    assert.equal(repeated.removed, false);
    await execution.cleanup({ scope: { repository: 'owner/repo', repositoryId: '123', runId: 'run-2' }, resource: 'scratch' });
    assert.equal(await missing(runTwoRoot), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
