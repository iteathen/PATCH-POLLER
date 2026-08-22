import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SshAccessProbe } from '../src/runtime/ssh-access-probe.js';

async function access(root) {
  const identityFile = path.join(root, 'identity');
  const knownHostsFile = path.join(root, 'known_hosts');
  await writeFile(identityFile, 'private');
  await writeFile(knownHostsFile, '* ssh-ed25519 AAAA\n');
  return { family: 'linux', user: 'devbridge', address: '192.0.2.10', identityFile, knownHostsFile };
}

test('SSH access probe enforces strict pinned noninteractive options', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ssh-probe-'));
  try {
    let supplied = null;
    const probe = new SshAccessProbe({ executable: 'ssh-test', invoke: async (input) => { supplied = input; return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: '' }; } });
    assert.equal((await probe.inspect(await access(root))).ready, true);
    assert.equal(supplied.executable, 'ssh-test');
    assert.ok(supplied.arguments.includes('StrictHostKeyChecking=yes'));
    assert.ok(supplied.arguments.includes('BatchMode=yes'));
    assert.ok(supplied.arguments.includes('PasswordAuthentication=no'));
    assert.ok(supplied.arguments.includes('KbdInteractiveAuthentication=no'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SSH access probe remains unready when exact trust files are absent or command fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ssh-probe-fail-'));
  try {
    const missing = new SshAccessProbe({ invoke: async () => { throw new Error('must not run'); } });
    assert.equal((await missing.inspect({ family: 'linux', user: 'devbridge', address: '192.0.2.10', identityFile: path.join(root, 'missing'), knownHostsFile: path.join(root, 'missing2') })).ready, false);
    const failed = new SshAccessProbe({ executable: 'ssh-test', invoke: async () => ({ exitCode: 255, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: 'host key mismatch' }) });
    const result = await failed.inspect(await access(root));
    assert.equal(result.ready, false);
    assert.match(result.reason, /host key mismatch/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
