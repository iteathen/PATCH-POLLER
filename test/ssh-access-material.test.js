import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SshAccessMaterial } from '../src/runtime/ssh-access-material.js';

const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const PUBLIC = `ssh-ed25519 ${'A'.repeat(44)}`;

test('SSH access material keeps a stable client identity and rotates only ephemeral guest host seed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ssh-material-'));
  try {
    let generations = 0;
    const invoke = async ({ arguments: args }) => {
      const base = args.at(-1);
      generations += 1;
      await writeFile(base, PRIVATE, { mode: 0o600 });
      await writeFile(`${base}.pub`, `${PUBLIC}\n`, { mode: 0o600 });
      return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: '' };
    };
    const material = new SshAccessMaterial({ directory: root, invoke, executable: 'ssh-keygen-test' });
    const connection = material.connection('env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const first = await material.prepare('env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const firstSeed = JSON.parse(await readFile(first.seedFile, 'utf8'));
    assert.equal(firstSeed.authorizedKey, PUBLIC);
    assert.equal(first.connection.identityFile, connection.identityFile);
    assert.equal(await readFile(connection.knownHostsFile, 'utf8'), `* ${PUBLIC}\n`);
    await first.cleanup();

    const second = await material.prepare('env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(generations, 3, 'client pair is reused; only the second guest host pair is regenerated');
    assert.equal(second.connection.identityFile, connection.identityFile);
    await second.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SSH access material refuses a partial persisted client identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ssh-partial-'));
  try {
    const material = new SshAccessMaterial({ directory: root, invoke: async () => { throw new Error('must not generate'); } });
    const connection = material.connection('env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await writeFile(connection.identityFile, PRIVATE, { recursive: true }).catch(async () => {
      const directory = path.dirname(connection.identityFile);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(directory, { recursive: true });
      await writeFile(connection.identityFile, PRIVATE);
    });
    await assert.rejects(() => material.prepare('env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), /incomplete/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
