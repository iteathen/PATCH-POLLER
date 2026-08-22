import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = fileURLToPath(new URL('../src/guest/bridge-agent.mjs', import.meta.url));
const protocol = 'devbridge/environment-bridge-v1';
const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const nodeProgram = path.basename(process.execPath);

function frame(request, kind, body) {
  return { protocol, request, target, kind, body };
}

async function exchange(root, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agent, '--exchange-stdin'], {
      env: { ...process.env, DEVBRIDGE_GUEST_BRIDGE_ROOT: root, DEVBRIDGE_GUEST_TARGET: target },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf8') || `agent exited ${code}`));
      try { resolve(JSON.parse(out)); }
      catch (error) { reject(new Error(`invalid agent output: ${out}`, { cause: error })); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function safeJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

async function monitorLossDiagnostic(root, request) {
  const directory = path.join(root, '.operations');
  const operation = await safeJson(path.join(directory, `${request}.json`));
  const claim = await safeJson(path.join(directory, `${request}.monitor.json`));
  let names = [];
  try { names = await readdir(directory); } catch {}
  return {
    request,
    operationState: operation?.state ?? null,
    monitorClaimState: claim?.state ?? null,
    operationTempCount: names.filter((name) => name.startsWith(`${request}.json.`) && name.endsWith('.tmp')).length,
    monitorTempCount: names.filter((name) => name.startsWith(`${request}.monitor.json.`) && name.endsWith('.tmp')).length,
  };
}

async function observeUntil(root, request, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await exchange(root, frame(request, 'observe', {}));
    assert.equal(observed.ok, true);
    if (observed.body.state === 'completed' || observed.body.state === 'failed') return observed.body;
    if (observed.body.state === 'indeterminate') {
      const diagnostic = await monitorLossDiagnostic(root, request);
      throw new Error(`observation became indeterminate: ${observed.body.reason}; diagnostic=${JSON.stringify(diagnostic)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation ${request} did not become terminal`);
}

test('fast children cannot exit before their completion hooks become authoritative', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-fast-child-'));
  try {
    const operation = {
      program: nodeProgram,
      arguments: ['-e', 'process.exit(0)'],
      directory: { class: 'work', path: '.' },
      environment: {},
      input: null,
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    };
    const requests = Array.from({ length: 16 }, (_, index) => (index + 1).toString(16).padStart(32, '0'));
    const started = await Promise.all(requests.map((request) => exchange(root, frame(request, 'execute', operation))));
    for (const response of started) assert.equal(response.ok, true);

    const completed = await Promise.all(requests.map((request) => observeUntil(root, request)));
    for (const result of completed) {
      assert.equal(result.state, 'completed');
      assert.equal(result.result.exitCode, 0);
      assert.equal(result.result.timedOut, false);
      assert.equal(result.result.aborted, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
