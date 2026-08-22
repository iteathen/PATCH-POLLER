#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runPermanentEntry } from './permanent-entry.mjs';
import { GitHubRunnerSource } from './github-runner-source.mjs';
import { ExperimentalSubjectAuthority } from './experimental-subject-authority.mjs';
import { ExperimentalCheckoutRunnerProvider } from './experimental-checkout-runner-provider.mjs';

function fail(message) { throw new Error(message); }

export function experimentalEntryCacheRoot({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const localPath = platform === 'win32' ? path.win32 : path.posix;
  const explicit = env.DEVBRIDGE_ENTRY_CACHE_ROOT;
  if (explicit != null) {
    if (typeof explicit !== 'string' || !localPath.isAbsolute(explicit)) fail('DEVBRIDGE_ENTRY_CACHE_ROOT must be an absolute local path');
    return localPath.resolve(explicit);
  }
  if (platform === 'win32') {
    const base = typeof env.LOCALAPPDATA === 'string' && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, 'DevBridge', 'entry');
  }
  const base = typeof env.XDG_CACHE_HOME === 'string' && path.posix.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : path.posix.join(home, '.cache');
  return path.posix.join(base, 'devbridge', 'entry');
}

export async function runExperimentalEntry(argv, {
  source = null,
  subjectAuthority = null,
  runnerProvider = null,
  cacheRoot = null,
} = {}) {
  const fixedSource = source ?? new GitHubRunnerSource();
  const experimental = subjectAuthority ?? new ExperimentalSubjectAuthority({ source: fixedSource });
  const authority = {
    async resolve(selector) {
      if (!selector || !['ref', 'exact'].includes(selector.kind)) {
        fail('experimental entry requires one explicit --ref or --branch selector');
      }
      return experimental.resolve(selector);
    },
  };
  const provider = runnerProvider ?? new ExperimentalCheckoutRunnerProvider({
    cacheRoot: cacheRoot ?? experimentalEntryCacheRoot(),
  });
  return runPermanentEntry(argv, { subjectAuthority: authority, runnerProvider: provider });
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const exitCode = await runExperimentalEntry(process.argv.slice(2));
    if (Number.isInteger(exitCode)) process.exitCode = exitCode;
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
