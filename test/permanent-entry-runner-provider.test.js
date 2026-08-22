import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContentAddressedRunnerProvider } from '../src/entry/content-addressed-runner-provider.mjs';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';

function subject(head, bytes) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    minimumEntryProtocol: 1,
    channel: 'experimental',
    releaseId: `development-${head}`,
  };
}

test('provider commits exact verified bytes once then reuses the content-addressed object', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-cache-'));
  try {
    const bytes = Buffer.from('runner-object');
    const exact = subject('a'.repeat(40), bytes);
    let reads = 0;
    const launches = [];
    const provider = new ContentAddressedRunnerProvider({
      cacheRoot: root,
      source: { async read(head) { reads += 1; assert.equal(head, exact.head); return bytes; } },
      launch(file, argv) { launches.push({ file, argv }); return 17; },
    });

    const first = await provider.prepare(exact);
    assert.equal(await first.launch(['doctor', '--config', 'local.json']), 17);
    assert.equal(reads, 1);
    assert.deepEqual(launches[0].argv, ['doctor', '--config', 'local.json']);
    assert.deepEqual(await readFile(launches[0].file), bytes);

    const second = await provider.prepare(exact);
    assert.equal(await second.launch([]), 17);
    assert.equal(reads, 1);
    assert.equal(launches[1].file, launches[0].file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider rejects mismatched fetched bytes before committing or launching them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-mismatch-'));
  try {
    const expected = Buffer.from('expected');
    const exact = subject('b'.repeat(40), expected);
    let launches = 0;
    const provider = new ContentAddressedRunnerProvider({
      cacheRoot: root,
      source: { async read() { return Buffer.from('different'); } },
      launch() { launches += 1; return 0; },
    });
    await assert.rejects(() => provider.prepare(exact), /do not match the exact subject/u);
    assert.equal(launches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider discards a corrupt cache object and restores only exact source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-corrupt-'));
  try {
    const bytes = Buffer.from('verified-runner');
    const exact = subject('c'.repeat(40), bytes);
    const objects = path.join(root, 'objects');
    await mkdir(objects, { recursive: true });
    const object = path.join(objects, `${exact.sha256}.mjs`);
    await writeFile(object, 'corrupt');
    let reads = 0;
    const provider = new ContentAddressedRunnerProvider({
      cacheRoot: root,
      source: { async read() { reads += 1; return bytes; } },
      launch() { return 0; },
    });
    await provider.prepare(exact);
    assert.equal(reads, 1);
    assert.deepEqual(await readFile(object), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider accepts only a local absolute cache root and closed string argv', async () => {
  assert.throws(() => new ContentAddressedRunnerProvider({ source: { read() {} }, cacheRoot: 'relative' }), /absolute local path/u);
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-argv-'));
  try {
    const bytes = Buffer.from('runner');
    const exact = subject('d'.repeat(40), bytes);
    const provider = new ContentAddressedRunnerProvider({
      cacheRoot: root,
      source: { async read() { return bytes; } },
      launch() { return 0; },
    });
    const prepared = await provider.prepare(exact);
    assert.throws(() => prepared.launch(['ok', { path: 'authority' }]), /array of strings/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
