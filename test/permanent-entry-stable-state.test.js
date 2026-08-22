import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { StableRunnerState } from '../src/entry/stable-runner-state.mjs';

function subject(head, digest, releaseId) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: digest,
    minimumEntryProtocol: 1,
    channel: 'stable',
    releaseId,
  };
}

function developmentRecord(value, acceptedAt) {
  return {
    subject: value,
    mode: 'development',
    sequence: null,
    manifestSha256: null,
    keyId: null,
    acceptedAt,
  };
}

function productionRecord(value, sequence, marker) {
  return {
    subject: value,
    mode: 'production',
    sequence,
    manifestSha256: marker.repeat(64),
    keyId: `key-${marker}`,
    acceptedAt: `2026-08-22T12:${String(sequence).padStart(2, '0')}:00.000Z`,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-entry-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, state: new StableRunnerState({ stateRoot: root }) };
}

test('stable runner state appends immutable revisions and preserves exact fallback order', async (t) => {
  const { root, state } = await fixture(t);
  const first = subject('1'.repeat(40), 'a'.repeat(64), 'development-one');
  const second = subject('2'.repeat(40), 'b'.repeat(64), 'development-two');

  const initial = await state.accept(developmentRecord(first, '2026-08-22T12:00:00.000Z'));
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.current.subject, first);
  assert.equal(initial.previous, null);

  const rotated = await state.accept(developmentRecord(second, '2026-08-22T12:01:00.000Z'));
  assert.equal(rotated.revision, 2);
  assert.deepEqual(rotated.current.subject, second);
  assert.deepEqual(rotated.previous.subject, first);

  assert.deepEqual(await readdir(path.join(root, 'stable')), ['000000000001.json', '000000000002.json']);
  assert.deepEqual(await state.fallback(second, 'development'), first);
  assert.deepEqual(
    await state.fallback(subject('3'.repeat(40), 'c'.repeat(64), 'development-three'), 'development'),
    second,
  );
});

test('re-accepting the same exact runner evidence does not append another revision', async (t) => {
  const { root, state } = await fixture(t);
  const selected = subject('4'.repeat(40), 'd'.repeat(64), 'development-four');
  const accepted = await state.accept(developmentRecord(selected, '2026-08-22T12:02:00.000Z'));
  const before = await readFile(path.join(root, 'stable', '000000000001.json'), 'utf8');

  const repeated = await state.accept(developmentRecord(selected, '2026-08-22T13:00:00.000Z'));
  const after = await readFile(path.join(root, 'stable', '000000000001.json'), 'utf8');

  assert.equal(repeated.revision, accepted.revision);
  assert.equal(after, before);
  assert.deepEqual(await readdir(path.join(root, 'stable')), ['000000000001.json']);
});

test('development and production fallback authority never cross modes', async (t) => {
  const { state } = await fixture(t);
  const development = subject('5'.repeat(40), 'e'.repeat(64), 'development-five');
  const production = subject('6'.repeat(40), 'f'.repeat(64), 'release-six');
  await state.accept(developmentRecord(development, '2026-08-22T12:03:00.000Z'));
  await state.accept(productionRecord(production, 1, 'a'));

  assert.deepEqual(await state.preferred('production'), production);
  assert.deepEqual(await state.preferred('development'), development);
  assert.equal(await state.fallback(production, 'production'), null);
  assert.deepEqual(await state.fallback(production, 'development'), development);
});

test('production accepted sequence cannot roll back or equivocate', async (t) => {
  const { state } = await fixture(t);
  const first = subject('7'.repeat(40), '1'.repeat(64), 'release-seven');
  const second = subject('8'.repeat(40), '2'.repeat(64), 'release-eight');
  await state.accept(productionRecord(first, 2, 'b'));

  await assert.rejects(() => state.accept(productionRecord(second, 1, 'c')), /roll back/u);
  await assert.rejects(() => state.accept(productionRecord(second, 2, 'd')), /conflicts/u);
  assert.deepEqual((await state.status()).current.subject, first);
});

test('stable runner status is bounded authority evidence and exposes no state-root path', async (t) => {
  const { root, state } = await fixture(t);
  const selected = subject('9'.repeat(40), '3'.repeat(64), 'development-nine');
  await state.accept(developmentRecord(selected, '2026-08-22T12:04:00.000Z'));

  const status = await state.status();
  assert.equal(status.configured, true);
  assert.equal(status.revision, 1);
  assert.deepEqual(status.current.subject, selected);
  assert.equal(JSON.stringify(status).includes(root), false);
});

test('malformed or corrupt immutable journal state fails closed instead of inventing LKG authority', async (t) => {
  const { root, state } = await fixture(t);
  const journal = path.join(root, 'stable');
  await mkdir(journal, { recursive: true });
  await writeFile(path.join(journal, '000000000001.json'), '{not-json\n', 'utf8');
  await assert.rejects(() => state.read(), /not valid JSON/u);
  await assert.rejects(
    () => state.fallback(subject('a'.repeat(40), '4'.repeat(64), 'development-ten'), 'development'),
    /not valid JSON/u,
  );
});
