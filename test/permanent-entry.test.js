import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMANENT_ENTRY_PROTOCOL,
  RUNNER_SUBJECT_PROTOCOL,
  parsePermanentEntryArgs,
  runPermanentEntry,
} from '../src/entry/permanent-entry.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = 'a'.repeat(64);

function subject(overrides = {}) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head: HEAD,
    sha256: DIGEST,
    minimumEntryProtocol: PERMANENT_ENTRY_PROTOCOL,
    channel: 'stable',
    releaseId: 'stable-2026-08-21',
    ...overrides,
  };
}

test('permanent entry defaults runner selection to stable without changing runner argv', () => {
  assert.deepEqual(parsePermanentEntryArgs(['daemon', '--channel', 'testing']), {
    selector: { kind: 'channel', value: 'stable' },
    argv: ['daemon', '--channel', 'testing'],
  });
});

test('explicit stable selection is preserved for the downstream runner', () => {
  assert.deepEqual(parsePermanentEntryArgs(['--channel', 'stable', 'doctor']), {
    selector: { kind: 'channel', value: 'stable' },
    argv: ['--channel', 'stable', 'doctor'],
  });
});

test('experimental branch and ref selectors are entry-local and resolve through one ref contract', () => {
  assert.deepEqual(parsePermanentEntryArgs(['daemon', '--branch', 'experimental/cache-work']), {
    selector: { kind: 'ref', value: 'experimental/cache-work' },
    argv: ['daemon'],
  });
  assert.deepEqual(parsePermanentEntryArgs(['--ref', HEAD.toUpperCase(), 'doctor']), {
    selector: { kind: 'exact', value: HEAD },
    argv: ['doctor'],
  });
});

test('permanent entry rejects ambiguous local selectors', () => {
  assert.throws(
    () => parsePermanentEntryArgs(['--ref', 'experimental/one', '--branch', 'experimental/two']),
    /Only one permanent-entry selector/u,
  );
  assert.throws(
    () => parsePermanentEntryArgs(['--channel', 'stable', '--ref', 'experimental/one']),
    /Only one permanent-entry selector/u,
  );
});

test('permanent entry resolves one exact subject, prepares that subject, and forwards runner argv', async () => {
  const calls = [];
  const resolved = subject();
  const status = await runPermanentEntry(
    ['daemon', '--ref', 'experimental/cache-work', '--channel', 'testing'],
    {
      subjectAuthority: {
        async resolve(selector) {
          calls.push(['resolve', selector]);
          return resolved;
        },
      },
      runnerProvider: {
        async prepare(observed) {
          calls.push(['prepare', observed]);
          return {
            subject: observed,
            async launch(argv) {
              calls.push(['launch', argv]);
              return 23;
            },
          };
        },
      },
    },
  );

  assert.equal(status, 23);
  assert.deepEqual(calls, [
    ['resolve', { kind: 'ref', value: 'experimental/cache-work' }],
    ['prepare', resolved],
    ['launch', ['daemon', '--channel', 'testing']],
  ]);
});

test('permanent entry fails before materialization when the resolved runner needs a newer entry protocol', async () => {
  let prepared = false;
  await assert.rejects(
    () => runPermanentEntry([], {
      subjectAuthority: { async resolve() { return subject({ minimumEntryProtocol: 2 }); } },
      runnerProvider: { async prepare() { prepared = true; return null; } },
    }),
    /requires permanent-entry protocol 2/u,
  );
  assert.equal(prepared, false);
});

test('permanent entry refuses a provider that substitutes a different exact runner subject', async () => {
  let launched = false;
  await assert.rejects(
    () => runPermanentEntry(['--ref', HEAD], {
      subjectAuthority: { async resolve() { return subject(); } },
      runnerProvider: {
        async prepare(observed) {
          return {
            subject: { ...observed, sha256: 'b'.repeat(64) },
            async launch() { launched = true; return 0; },
          };
        },
      },
    }),
    /prepared runner subject changed after exact resolution/u,
  );
  assert.equal(launched, false);
});
