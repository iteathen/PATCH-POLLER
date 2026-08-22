#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRY_CANDIDATE_BUNDLE_PROTOCOL = 'devbridge/entry-candidate-bundle-v1';

const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_COMPONENT_BYTES = 1024 * 1024;
const COMPONENTS = Object.freeze([
  'devbridge-entry.mjs',
  'src/entry/content-addressed-runner-provider.mjs',
  'src/entry/development-stable-subject-authority.mjs',
  'src/entry/experimental-checkout-runner-provider.mjs',
  'src/entry/experimental-entry.mjs',
  'src/entry/experimental-subject-authority.mjs',
  'src/entry/github-runner-source.mjs',
  'src/entry/installation-identity.mjs',
  'src/entry/permanent-entry.mjs',
  'src/entry/production-stable-subject-authority.mjs',
  'src/entry/stable-entry.mjs',
  'src/entry/stable-runner-state.mjs',
]);

function fail(message) { throw new Error(message); }

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function readRegularFile(candidate, name, { root = null } = {}) {
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_COMPONENT_BYTES) {
    fail(`${name} must be a bounded real regular file`);
  }
  const actual = await realpath(candidate);
  if (root != null) {
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${name} escaped its source root`);
  }
  return readFile(actual);
}

async function requireRealDirectory(candidate, name) {
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory`);
  return realpath(candidate);
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function componentTarget(root, relative) {
  return path.join(root, ...relative.split('/'));
}

export async function stageEntryCandidate({ stableLauncher, output, sourceRoot = SOURCE_ROOT } = {}) {
  const stablePath = requireAbsolutePath(stableLauncher, 'stable launcher');
  const outputPath = requireAbsolutePath(output, 'candidate output');
  const sourcePath = await requireRealDirectory(path.resolve(sourceRoot), 'candidate source root');
  const parent = await requireRealDirectory(path.dirname(outputPath), 'candidate output parent');
  if (await exists(outputPath)) fail('candidate output must not already exist');

  const stableBytes = await readRegularFile(stablePath, 'stable launcher');
  const sources = [];
  for (const relative of COMPONENTS) {
    const bytes = await readRegularFile(componentTarget(sourcePath, relative), `candidate component ${relative}`, { root: sourcePath });
    sources.push({ relative, bytes });
  }

  const temporary = path.join(parent, `.${path.basename(outputPath)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    // Preserve the previously installed launcher bytes only as cutover rollback
    // evidence. The candidate permanent router has no default-path dependency
    // on this file.
    await writeFile(path.join(temporary, 'devbridge.mjs'), stableBytes, { mode: 0o600, flag: 'wx' });
    const files = [];
    for (const { relative, bytes } of sources) {
      const target = componentTarget(temporary, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: relative === 'devbridge-entry.mjs' ? 0o700 : 0o600, flag: 'wx' });
      files.push(Object.freeze({ path: relative, sha256: digest(bytes) }));
    }
    const evidence = Object.freeze({
      protocol: ENTRY_CANDIDATE_BUNDLE_PROTOCOL,
      entry: 'devbridge-entry.mjs',
      stableLauncher: Object.freeze({ path: 'devbridge.mjs', sha256: digest(stableBytes), role: 'rollback-only' }),
      files: Object.freeze(files),
    });
    await writeFile(
      path.join(temporary, 'entry-candidate-manifest.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    if (await exists(outputPath)) fail('candidate output appeared during staging');
    await rename(temporary, outputPath);
    return Object.freeze({ output: outputPath, manifest: evidence });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseCli(argv) {
  let stableLauncher = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--stable-launcher', '--output'].includes(flag)) fail(`unsupported staging argument: ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires an absolute local path`);
    if (flag === '--stable-launcher') {
      if (stableLauncher != null) fail('--stable-launcher may be supplied only once');
      stableLauncher = value;
    } else {
      if (output != null) fail('--output may be supplied only once');
      output = value;
    }
    index += 1;
  }
  if (stableLauncher == null || output == null) fail('staging requires --stable-launcher and --output');
  return { stableLauncher, output };
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const staged = await stageEntryCandidate(parseCli(process.argv.slice(2)));
    process.stdout.write(`${staged.output}\n`);
  } catch (error) {
    process.stderr.write(`[entry-candidate] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
