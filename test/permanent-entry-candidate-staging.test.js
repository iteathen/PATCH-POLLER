import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ENTRY_CANDIDATE_BUNDLE_PROTOCOL,
  stageEntryCandidate,
} from '../scripts/stage-entry-candidate.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('qualification staging preserves rollback launcher bytes and creates a closed self-contained permanent-entry candidate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'devbridge-entry-candidate-'));
  const installed = path.join(root, 'installed');
  const candidates = path.join(root, 'candidates');
  const entryHome = path.join(root, 'entry-home');
  await mkdir(installed);
  await mkdir(candidates);
  const stable = path.join(installed, 'devbridge.mjs');
  const stableBytes = Buffer.from(`throw new Error('ROLLBACK_ONLY_MUST_NOT_LOAD');\n`);
  await writeFile(stable, stableBytes);

  const output = path.join(candidates, 'candidate-a');
  const staged = await stageEntryCandidate({ stableLauncher: stable, output });

  assert.equal(staged.output, output);
  assert.equal(staged.manifest.protocol, ENTRY_CANDIDATE_BUNDLE_PROTOCOL);
  assert.equal(staged.manifest.stableLauncher.path, 'devbridge.mjs');
  assert.equal(staged.manifest.stableLauncher.role, 'rollback-only');
  assert.equal(staged.manifest.stableLauncher.sha256, digest(stableBytes));
  assert.deepEqual(await readFile(stable), stableBytes);
  assert.deepEqual(await readFile(path.join(output, 'devbridge.mjs')), stableBytes);

  const required = new Set([
    'devbridge-entry.mjs',
    'src/entry/content-addressed-runner-provider.mjs',
    'src/entry/development-stable-subject-authority.mjs',
    'src/entry/experimental-entry.mjs',
    'src/entry/github-runner-source.mjs',
    'src/entry/installation-identity.mjs',
    'src/entry/permanent-entry.mjs',
    'src/entry/production-stable-subject-authority.mjs',
    'src/entry/stable-entry.mjs',
    'src/entry/stable-runner-state.mjs',
  ]);
  for (const entry of staged.manifest.files) {
    const stagedBytes = await readFile(path.join(output, ...entry.path.split('/')));
    assert.equal(digest(stagedBytes), entry.sha256, entry.path);
    required.delete(entry.path);
  }
  assert.deepEqual([...required], []);

  const manifest = JSON.parse(await readFile(path.join(output, 'entry-candidate-manifest.json'), 'utf8'));
  assert.deepEqual(manifest, staged.manifest);
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const selectedModule = pathToFileURL(path.join(output, 'src', 'entry', 'experimental-entry.mjs')).href;
  const selected = await import(`${selectedModule}?candidate=${Date.now()}`);
  assert.equal(typeof selected.runExperimentalEntry, 'function');
  const stableModule = pathToFileURL(path.join(output, 'src', 'entry', 'stable-entry.mjs')).href;
  const defaultEntry = await import(`${stableModule}?candidate=${Date.now()}`);
  assert.equal(typeof defaultEntry.runStableEntry, 'function');

  const result = spawnSync(process.execPath, [path.join(output, 'devbridge-entry.mjs'), 'entry-status'], {
    cwd: output,
    env: { ...process.env, DEVBRIDGE_HOME: entryHome },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  const status = JSON.parse(result.stdout);
  assert.equal(status.protocol, 'devbridge/entry-status-v1');
  assert.match(status.installationTag, /^DB-[0-9A-F]{12}$/u);
  assert.equal(status.stable.configured, false);

  await assert.rejects(
    () => stageEntryCandidate({ stableLauncher: stable, output }),
    /candidate output must not already exist/u,
  );
});

test('qualification staging requires explicit absolute local paths', async () => {
  await assert.rejects(
    () => stageEntryCandidate({ stableLauncher: 'devbridge.mjs', output: 'candidate' }),
    /stable launcher must be an absolute local path/u,
  );
});
