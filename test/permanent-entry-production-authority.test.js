import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ProductionStableSubjectAuthority,
  RUNNER_MANIFEST_PROTOCOL,
  RUNNER_REPOSITORY,
  runnerReleasePayload,
} from '../src/entry/production-stable-subject-authority.mjs';
import { StableRunnerState } from '../src/entry/stable-runner-state.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');

function release(sequence, head = String(sequence).repeat(40).slice(0, 40), sha256 = String(sequence).repeat(64).slice(0, 64)) {
  return {
    repository: RUNNER_REPOSITORY,
    head,
    sha256,
    minimumEntryProtocol: 1,
    channel: 'stable',
    releaseId: `stable-${sequence}`,
    sequence,
  };
}

function manifestBytes(value, keyId = 'test-key') {
  const signature = sign(null, runnerReleasePayload(value), privateKey).toString('base64');
  return Buffer.from(JSON.stringify({
    protocol: RUNNER_MANIFEST_PROTOCOL,
    release: value,
    signature: { algorithm: 'ed25519', keyId, value: signature },
  }), 'utf8');
}

async function fixture(t, getManifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-entry-production-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new StableRunnerState({ stateRoot: root });
  const authority = new ProductionStableSubjectAuthority({
    manifestSource: { async read() { return getManifest(); } },
    publicKeySource: { async read() { return PUBLIC_KEY; } },
    state,
  });
  return { state, authority };
}

test('production stable authority verifies signed immutable runner subject before acceptance', async (t) => {
  const signed = release(1, '1'.repeat(40), 'a'.repeat(64));
  const bytes = manifestBytes(signed);
  const { state, authority } = await fixture(t, () => bytes);

  const selected = await authority.resolve({ kind: 'channel', value: 'stable' });
  assert.equal(selected.head, signed.head);
  assert.equal(selected.sha256, signed.sha256);
  assert.equal(selected.releaseId, signed.releaseId);
  assert.equal((await state.status()).configured, false);

  await authority.accept(selected);
  const accepted = await state.status();
  assert.equal(accepted.current.mode, 'production');
  assert.equal(accepted.current.sequence, 1);
  assert.equal(accepted.current.keyId, 'test-key');
  assert.deepEqual(accepted.current.subject, selected);
});

test('invalid production signature fails closed when no prior production LKG exists', async (t) => {
  const signed = release(1, '2'.repeat(40), 'b'.repeat(64));
  const parsed = JSON.parse(manifestBytes(signed).toString('utf8'));
  parsed.release.sha256 = 'c'.repeat(64);
  const { authority } = await fixture(t, () => Buffer.from(JSON.stringify(parsed), 'utf8'));

  await assert.rejects(() => authority.resolve({ kind: 'channel', value: 'stable' }), /signature verification failed/u);
});

test('failed or tampered production refresh preserves the previously accepted production subject', async (t) => {
  let bytes = manifestBytes(release(2, '3'.repeat(40), 'd'.repeat(64)));
  const { state, authority } = await fixture(t, () => bytes);
  const accepted = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(accepted);

  bytes = Buffer.from('{bad-json', 'utf8');
  const fallback = await authority.resolve({ kind: 'channel', value: 'stable' });
  assert.deepEqual(fallback, accepted);
  assert.deepEqual((await state.status()).current.subject, accepted);
});

test('lower signed sequence cannot roll stable production authority backward', async (t) => {
  let bytes = manifestBytes(release(5, '4'.repeat(40), 'e'.repeat(64)));
  const { state, authority } = await fixture(t, () => bytes);
  const current = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(current);

  bytes = manifestBytes(release(4, '5'.repeat(40), 'f'.repeat(64)));
  const selected = await authority.resolve({ kind: 'channel', value: 'stable' });
  assert.deepEqual(selected, current);
  assert.equal((await state.status()).current.sequence, 5);
});

test('equal signed sequence with different exact authority is treated as equivocation', async (t) => {
  let bytes = manifestBytes(release(7, '6'.repeat(40), '1'.repeat(64)));
  const { authority } = await fixture(t, () => bytes);
  const current = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(current);

  bytes = manifestBytes(release(7, '7'.repeat(40), '2'.repeat(64)));
  await assert.rejects(() => authority.resolve({ kind: 'channel', value: 'stable' }), /conflicts with accepted production authority/u);
});

test('production preparation recovery never falls back into development authority', async (t) => {
  const bytes = manifestBytes(release(9, '8'.repeat(40), '3'.repeat(64)));
  const { state, authority } = await fixture(t, () => bytes);
  const production = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(production);

  await state.accept({
    subject: {
      ...production,
      head: '9'.repeat(40),
      sha256: '4'.repeat(64),
      releaseId: 'development-nine',
    },
    mode: 'development',
    sequence: null,
    manifestSha256: null,
    keyId: null,
    acceptedAt: '2026-08-22T13:00:00.000Z',
  });

  assert.deepEqual(await authority.recover(production), null);
});
