import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stage0InstallationTag } from '../devbridge.mjs';
import { entryInstallationTag } from '../src/entry/installation-identity.mjs';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { StableRunnerState } from '../src/entry/stable-runner-state.mjs';
import { parseStableEntryArgs, runStableEntry, stableEntryPaths } from '../src/entry/stable-entry.mjs';

const HEAD = '1'.repeat(40);
const BYTES = Buffer.from('stable runner\n', 'utf8');
const DIGEST = createHash('sha256').update(BYTES).digest('hex');

async function homeFixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-stable-entry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('entry-owned installation tag remains exactly compatible with the existing installation identity', async (t) => {
  const home = await homeFixture(t);
  assert.equal(await entryInstallationTag(home), stage0InstallationTag(home));
});

test('stable entry consumes only entry-local signing flags and preserves runtime arguments', async (t) => {
  const home = await homeFixture(t);
  const manifest = path.join(home, 'runner-manifest.json');
  const publicKey = path.join(home, 'runner-key.pem');
  const parsed = parseStableEntryArgs([
    '--home', home,
    '--release-mode', 'production',
    '--entry-runner-manifest', manifest,
    '--entry-runner-public-key', publicKey,
    'doctor', '--config', 'local.json',
  ], { env: {}, homeDirectory: home });

  assert.equal(parsed.home, path.resolve(home));
  assert.equal(parsed.releaseMode, 'production');
  assert.equal(parsed.manifest, path.resolve(manifest));
  assert.equal(parsed.publicKey, path.resolve(publicKey));
  assert.deepEqual(parsed.argv, ['--home', home, '--release-mode', 'production', 'doctor', '--config', 'local.json']);
});

test('development stable entry resolves exact runner, accepts it after preparation, and forwards runtime argv', async (t) => {
  const home = await homeFixture(t);
  const calls = [];
  const source = {
    async resolve(ref) { calls.push(['resolve', ref]); return HEAD; },
    async read(head) { calls.push(['read', head]); return BYTES; },
  };
  const status = await runStableEntry(['--home', home, 'doctor'], {
    env: {},
    homeDirectory: home,
    source,
    runnerProvider: {
      async prepare(subject) {
        calls.push(['prepare', subject]);
        return {
          subject,
          async launch(argv) { calls.push(['launch', argv]); return 31; },
        };
      },
    },
  });

  assert.equal(status, 31);
  assert.equal(calls[0][0], 'resolve');
  assert.deepEqual(calls.at(-1), ['launch', ['--home', home, 'doctor']]);
  const state = new StableRunnerState({ stateRoot: stableEntryPaths(home).stateRoot });
  const accepted = await state.status();
  assert.equal(accepted.current.mode, 'development');
  assert.equal(accepted.current.subject.head, HEAD);
  assert.equal(accepted.current.subject.sha256, DIGEST);
});

test('--no-update uses only already accepted mode-matched authority', async (t) => {
  const home = await homeFixture(t);
  const paths = stableEntryPaths(home);
  const state = new StableRunnerState({ stateRoot: paths.stateRoot });
  const accepted = {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head: '2'.repeat(40),
    sha256: 'a'.repeat(64),
    minimumEntryProtocol: 1,
    channel: 'stable',
    releaseId: 'development-two',
  };
  await state.accept({
    subject: accepted,
    mode: 'development',
    sequence: null,
    manifestSha256: null,
    keyId: null,
    acceptedAt: '2026-08-22T12:00:00.000Z',
  });
  let sourceCalls = 0;
  const status = await runStableEntry(['--home', home, '--no-update', 'doctor'], {
    env: {},
    homeDirectory: home,
    state,
    source: {
      async resolve() { sourceCalls += 1; throw new Error('must not resolve'); },
      async read() { sourceCalls += 1; throw new Error('must not read'); },
    },
    runnerProvider: {
      async prepare(subject) {
        assert.deepEqual(subject, accepted);
        return { subject, async launch() { return 37; } };
      },
    },
  });
  assert.equal(status, 37);
  assert.equal(sourceCalls, 0);
});

test('entry-status returns path-free installation and stable runner evidence without loading a runner', async (t) => {
  const home = await homeFixture(t);
  const output = [];
  const status = await runStableEntry(['entry-status'], {
    env: { DEVBRIDGE_HOME: home },
    homeDirectory: home,
    source: {
      async resolve() { throw new Error('status must not resolve source'); },
      async read() { throw new Error('status must not read source'); },
    },
    runnerProvider: {
      async prepare() { throw new Error('status must not prepare runner'); },
    },
    write(text) { output.push(text); },
  });

  assert.equal(status, 0);
  const observed = JSON.parse(output.join(''));
  assert.equal(observed.protocol, 'devbridge/entry-status-v1');
  assert.match(observed.installationTag, /^DB-[0-9A-F]{12}$/u);
  assert.equal(observed.stable.configured, false);
  assert.equal(JSON.stringify(observed).includes(home), false);
});

test('development mode rejects production signing inputs instead of silently ignoring them', async (t) => {
  const home = await homeFixture(t);
  assert.throws(
    () => parseStableEntryArgs(['--entry-runner-manifest', path.join(home, 'manifest.json')], { env: {}, homeDirectory: home }),
    /require --release-mode production/u,
  );
});
