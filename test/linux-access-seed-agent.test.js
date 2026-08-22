import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyLinuxAccessSeed, LINUX_ACCESS_SEED_PROTOCOL, normalizeLinuxAccessSeed } from '../src/guest/linux-access-seed-agent.mjs';

const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const PUBLIC = `ssh-ed25519 ${'A'.repeat(44)}`;
function seed() { return { protocol: LINUX_ACCESS_SEED_PROTOCOL, target: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', user: 'devbridge', authorizedKey: PUBLIC, hostPrivateKey: PRIVATE, hostPublicKey: PUBLIC, revision: 1 }; }
function digest(value) { return createHash('sha256').update(JSON.stringify(normalizeLinuxAccessSeed(value)), 'utf8').digest('hex'); }

test('Linux access seed is bounded to the local user and exact schema', () => {
  assert.equal(normalizeLinuxAccessSeed(seed()).user, 'devbridge');
  assert.throws(() => normalizeLinuxAccessSeed({ ...seed(), user: 'root' }), /unsupported/u);
  assert.throws(() => normalizeLinuxAccessSeed({ ...seed(), command: 'anything' }), /not allowed/u);
});

test('Linux access seed persists only digest evidence and removes secret seed after apply', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-linux-access-agent-'));
  try {
    const seedFile = path.join(root, 'seed.json');
    const stateFile = path.join(root, 'state.json');
    const value = seed();
    await writeFile(seedFile, `${JSON.stringify(value)}\n`);
    let installs = 0;
    const install = async () => {
      installs += 1;
      return { target: value.target, seedSha256: digest(value), hostPublicSha256: 'host-digest', authorizedPublicSha256: 'client-digest' };
    };
    assert.deepEqual(await applyLinuxAccessSeed({ seedFile, stateFile, install }), { changed: true, target: value.target });
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.seedSha256, digest(value));
    assert.equal(JSON.stringify(state).includes('OPENSSH PRIVATE KEY'), false);
    await assert.rejects(() => readFile(seedFile, 'utf8'), /ENOENT/u);

    await writeFile(seedFile, `${JSON.stringify(value)}\n`);
    assert.deepEqual(await applyLinuxAccessSeed({ seedFile, stateFile, install }), { changed: false, target: value.target });
    assert.equal(installs, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
