import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DevelopmentStableSubjectAuthority } from '../src/entry/development-stable-subject-authority.mjs';
import { StableRunnerState } from '../src/entry/stable-runner-state.mjs';

const FIRST_HEAD = '1'.repeat(40);
const SECOND_HEAD = '2'.repeat(40);
const FIRST_BYTES = Buffer.from('first runner\n', 'utf8');
const SECOND_BYTES = Buffer.from('second runner\n', 'utf8');

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-entry-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new StableRunnerState({ stateRoot: root });
  const authority = new DevelopmentStableSubjectAuthority({ source, state });
  return { state, authority };
}

test('development stable resolution is exact but does not become accepted until the prepare boundary calls accept', async (t) => {
  const source = {
    async resolve(ref) { assert.equal(ref, 'main'); return FIRST_HEAD; },
    async read(head) { assert.equal(head, FIRST_HEAD); return FIRST_BYTES; },
  };
  const { state, authority } = await fixture(t, source);
  const selected = await authority.resolve({ kind: 'channel', value: 'stable' });

  assert.equal(selected.head, FIRST_HEAD);
  assert.equal(selected.sha256, digest(FIRST_BYTES));
  assert.equal(selected.channel, 'stable');
  assert.equal((await state.status()).configured, false);

  await authority.accept(selected, { kind: 'channel', value: 'stable' });
  const accepted = await state.status();
  assert.equal(accepted.configured, true);
  assert.deepEqual(accepted.current.subject, selected);
});

test('source failure preserves and returns the exact already accepted stable runner', async (t) => {
  let failSource = false;
  const source = {
    async resolve() {
      if (failSource) throw new Error('source offline');
      return FIRST_HEAD;
    },
    async read() { return FIRST_BYTES; },
  };
  const { state, authority } = await fixture(t, source);
  const first = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(first, { kind: 'channel', value: 'stable' });
  const before = await state.status();

  failSource = true;
  const offline = await authority.resolve({ kind: 'channel', value: 'stable' });
  assert.deepEqual(offline, first);
  await authority.accept(offline, { kind: 'channel', value: 'stable' });
  assert.deepEqual(await state.status(), before);
});

test('failed preparation of a newly resolved runner falls back to current without accepting the failed candidate', async (t) => {
  let head = FIRST_HEAD;
  const source = {
    async resolve() { return head; },
    async read(value) { return value === FIRST_HEAD ? FIRST_BYTES : SECOND_BYTES; },
  };
  const { state, authority } = await fixture(t, source);
  const first = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(first, { kind: 'channel', value: 'stable' });

  head = SECOND_HEAD;
  const second = await authority.resolve({ kind: 'channel', value: 'stable' });
  assert.equal(second.sha256, digest(SECOND_BYTES));
  const fallback = await authority.recover(second, new Error('cache publication failed'));
  assert.deepEqual(fallback, first);
  assert.deepEqual((await state.status()).current.subject, first);
});

test('failed preparation of current accepted runner falls back to previous accepted runner', async (t) => {
  let head = FIRST_HEAD;
  const source = {
    async resolve() { return head; },
    async read(value) { return value === FIRST_HEAD ? FIRST_BYTES : SECOND_BYTES; },
  };
  const { state, authority } = await fixture(t, source);
  const first = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(first, { kind: 'channel', value: 'stable' });
  head = SECOND_HEAD;
  const second = await authority.resolve({ kind: 'channel', value: 'stable' });
  await authority.accept(second, { kind: 'channel', value: 'stable' });

  const fallback = await authority.recover(second, new Error('accepted cache corrupt'));
  assert.deepEqual(fallback, first);
  assert.deepEqual((await state.status()).current.subject, second);
});

test('development stable authority rejects selectors outside its local stable contract', async (t) => {
  const source = { async resolve() { return FIRST_HEAD; }, async read() { return FIRST_BYTES; } };
  const { authority } = await fixture(t, source);
  await assert.rejects(() => authority.resolve({ kind: 'ref', value: 'feature/x' }), /stable channel/u);
});
