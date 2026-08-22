import test from 'node:test';
import assert from 'node:assert/strict';
import { runExperimentalEntry, experimentalEntryCacheRoot } from '../src/entry/experimental-entry.mjs';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';

function subject(head = 'a'.repeat(40)) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: 'b'.repeat(64),
    minimumEntryProtocol: 1,
    channel: 'experimental',
    releaseId: `development-${head}`,
  };
}

test('experimental entry consumes only its selector and forwards ordinary control-plane argv', async () => {
  const selections = [];
  const launches = [];
  const exact = subject();
  const result = await runExperimentalEntry([
    '--ref', 'fix/157-controller-owned-fixture',
    'daemon', '--config', 'local.json', '--repository', 'iteathen/DevBridge',
  ], {
    subjectAuthority: {
      async resolve(selector) { selections.push(selector); return exact; },
    },
    runnerProvider: {
      async prepare(resolved) {
        assert.deepEqual(resolved, exact);
        return {
          subject: resolved,
          launch(argv) { launches.push(argv); return 31; },
        };
      },
    },
  });

  assert.equal(result, 31);
  assert.deepEqual(selections, [{ kind: 'ref', value: 'fix/157-controller-owned-fixture' }]);
  assert.deepEqual(launches, [['daemon', '--config', 'local.json', '--repository', 'iteathen/DevBridge']]);
});

test('experimental entry turns a 40-hex ref into exact immutable selection', async () => {
  const head = 'c'.repeat(40);
  let observed = null;
  await runExperimentalEntry(['--branch', head.toUpperCase(), 'doctor', '--config', 'local.json'], {
    subjectAuthority: {
      async resolve(selector) { observed = selector; return subject(head); },
    },
    runnerProvider: {
      async prepare(resolved) { return { subject: resolved, launch() { return 0; } }; },
    },
  });
  assert.deepEqual(observed, { kind: 'exact', value: head });
});

test('development-only composition refuses implicit or stable runner authority', async () => {
  const never = {
    async resolve() { throw new Error('must not resolve'); },
  };
  const provider = {
    async prepare() { throw new Error('must not prepare'); },
  };
  await assert.rejects(() => runExperimentalEntry(['doctor', '--config', 'local.json'], { subjectAuthority: never, runnerProvider: provider }), /requires one explicit --ref or --branch/u);
  await assert.rejects(() => runExperimentalEntry(['--channel', 'stable', 'doctor', '--config', 'local.json'], { subjectAuthority: never, runnerProvider: provider }), /requires one explicit --ref or --branch/u);
});

test('experimental cache location is local and platform-specific', () => {
  assert.equal(
    experimentalEntryCacheRoot({
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    }),
    'C:\\Users\\tester\\AppData\\Local\\DevBridge\\entry',
  );
  assert.equal(
    experimentalEntryCacheRoot({ platform: 'linux', home: '/home/tester', env: { XDG_CACHE_HOME: '/cache/tester' } }),
    '/cache/tester/devbridge/entry',
  );
  assert.throws(
    () => experimentalEntryCacheRoot({ platform: 'linux', home: '/home/tester', env: { DEVBRIDGE_ENTRY_CACHE_ROOT: 'relative/cache' } }),
    /absolute local path/u,
  );
});
