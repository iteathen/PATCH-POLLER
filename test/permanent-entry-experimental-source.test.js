import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ExperimentalSubjectAuthority } from '../src/entry/experimental-subject-authority.mjs';
import { GitHubRunnerSource } from '../src/entry/github-runner-source.mjs';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';

function response(body, ok = true) {
  return { ok, async json() { return body; } };
}

test('fixed source resolves one local ref then reads runner bytes only by exact commit', async () => {
  const head = 'a'.repeat(40);
  const bytes = Buffer.from('runner-bytes');
  const calls = [];
  const source = new GitHubRunnerSource({
    request: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response({ sha: head });
      return response({ type: 'file', path: 'devbridge.mjs', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
    },
  });

  assert.equal(await source.resolve('fix/example-branch'), head);
  assert.deepEqual(await source.read(head), bytes);
  assert.equal(calls[0].url, 'https://api.github.com/repos/iteathen/DevBridge/commits/fix%2Fexample-branch');
  assert.equal(calls[1].url, `https://api.github.com/repos/iteathen/DevBridge/contents/devbridge.mjs?ref=${head}`);
  assert.equal(calls.every((entry) => entry.options.redirect === 'error'), true);
});

test('fixed source rejects unsafe selectors and malformed artifact records before exposing bytes', async () => {
  const source = new GitHubRunnerSource({ request: async () => response({ sha: 'a'.repeat(40) }) });
  for (const value of ['../main', '-main', 'refs/@{upstream}', 'name.lock']) {
    await assert.rejects(() => source.resolve(value), /selector is invalid/u);
  }

  const malformed = new GitHubRunnerSource({
    request: async () => response({ type: 'file', path: 'devbridge.mjs', encoding: 'base64', size: 4, content: '%%%%' }),
  });
  await assert.rejects(() => malformed.read('b'.repeat(40)), /artifact encoding is invalid/u);
});

test('experimental authority removes moving ref identity after one exact resolution', async () => {
  const head = 'c'.repeat(40);
  const bytes = Buffer.from('exact-runner');
  const calls = [];
  const authority = new ExperimentalSubjectAuthority({
    source: {
      async resolve(ref) { calls.push(['resolve', ref]); return head; },
      async read(value) { calls.push(['read', value]); return bytes; },
    },
  });

  const subject = await authority.resolve({ kind: 'ref', value: 'fix/157-controller-owned-fixture' });
  assert.deepEqual(calls, [['resolve', 'fix/157-controller-owned-fixture'], ['read', head]]);
  assert.deepEqual(subject, {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    minimumEntryProtocol: 1,
    channel: 'experimental',
    releaseId: `development-${head}`,
  });
  assert.doesNotMatch(JSON.stringify(subject), /fix\/157-controller-owned-fixture/u);
});

test('exact experimental selector never resolves through a moving name and still verifies exact bytes', async () => {
  const head = 'd'.repeat(40);
  let resolveCalls = 0;
  const authority = new ExperimentalSubjectAuthority({
    source: {
      async resolve() { resolveCalls += 1; return 'e'.repeat(40); },
      async read(value) { assert.equal(value, head); return Buffer.from('verified'); },
    },
  });
  const subject = await authority.resolve({ kind: 'exact', value: head.toUpperCase() });
  assert.equal(resolveCalls, 0);
  assert.equal(subject.head, head);
});

test('experimental authority rejects stable-channel and authority-shaped selector extensions', async () => {
  const authority = new ExperimentalSubjectAuthority({
    source: { async resolve() { return 'a'.repeat(40); }, async read() { return Buffer.from('x'); } },
  });
  await assert.rejects(() => authority.resolve({ kind: 'channel', value: 'stable' }), /selector is invalid/u);
  await assert.rejects(() => authority.resolve({ kind: 'ref', value: 'main', source: 'elsewhere' }), /source is not allowed/u);
});
