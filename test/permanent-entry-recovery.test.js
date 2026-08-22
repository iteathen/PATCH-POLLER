import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNNER_SUBJECT_PROTOCOL, runPermanentEntry } from '../src/entry/permanent-entry.mjs';

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

const CURRENT = subject('1'.repeat(40), 'a'.repeat(64), 'current');
const CANDIDATE = subject('2'.repeat(40), 'b'.repeat(64), 'candidate');

test('permanent entry accepts a resolved subject only after exact preparation succeeds', async () => {
  const calls = [];
  const status = await runPermanentEntry(['doctor'], {
    subjectAuthority: {
      async resolve() { calls.push('resolve'); return CANDIDATE; },
      async accept(value) { calls.push(['accept', value]); },
    },
    runnerProvider: {
      async prepare(value) {
        calls.push(['prepare', value]);
        return { subject: value, async launch() { calls.push('launch'); return 0; } };
      },
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    'resolve',
    ['prepare', CANDIDATE],
    ['accept', CANDIDATE],
    'launch',
  ]);
});

test('failed candidate preparation can recover exactly once to a different accepted subject', async () => {
  const calls = [];
  const status = await runPermanentEntry(['doctor'], {
    subjectAuthority: {
      async resolve() { return CANDIDATE; },
      async recover(failed, error) {
        calls.push(['recover', failed, error.message]);
        return CURRENT;
      },
      async accept(value) { calls.push(['accept', value]); },
    },
    runnerProvider: {
      async prepare(value) {
        calls.push(['prepare', value]);
        if (value.head === CANDIDATE.head) throw new Error('candidate cache unavailable');
        return { subject: value, async launch() { calls.push('launch'); return 17; } };
      },
    },
  });

  assert.equal(status, 17);
  assert.deepEqual(calls, [
    ['prepare', CANDIDATE],
    ['recover', CANDIDATE, 'candidate cache unavailable'],
    ['prepare', CURRENT],
    ['accept', CURRENT],
    'launch',
  ]);
});

test('recovery cannot return the same subject that already failed preparation', async () => {
  let attempts = 0;
  await assert.rejects(
    () => runPermanentEntry([], {
      subjectAuthority: {
        async resolve() { return CANDIDATE; },
        async recover() { return CANDIDATE; },
      },
      runnerProvider: {
        async prepare() { attempts += 1; throw new Error('unavailable'); },
      },
    }),
    /failed subject again/u,
  );
  assert.equal(attempts, 1);
});

test('fallback preparation failure remains terminal and is never recursively recovered', async () => {
  const attempts = [];
  await assert.rejects(
    () => runPermanentEntry([], {
      subjectAuthority: {
        async resolve() { return CANDIDATE; },
        async recover() { return CURRENT; },
      },
      runnerProvider: {
        async prepare(value) { attempts.push(value.head); throw new Error(`unavailable ${value.releaseId}`); },
      },
    }),
    /unavailable current/u,
  );
  assert.deepEqual(attempts, [CANDIDATE.head, CURRENT.head]);
});
