#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ContentAddressedRunnerProvider } from './content-addressed-runner-provider.mjs';
import { DevelopmentStableSubjectAuthority } from './development-stable-subject-authority.mjs';
import { GitHubRunnerSource } from './github-runner-source.mjs';
import { entryInstallationTag } from './installation-identity.mjs';
import { PERMANENT_ENTRY_PROTOCOL, runPermanentEntry, sameRunnerSubject } from './permanent-entry.mjs';
import { ProductionStableSubjectAuthority } from './production-stable-subject-authority.mjs';
import { StableRunnerState } from './stable-runner-state.mjs';

export const ENTRY_STATUS_PROTOCOL = 'devbridge/entry-status-v1';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const ENTRY_VALUE_FLAGS = new Set(['--entry-runner-manifest', '--entry-runner-public-key']);

function fail(message) { throw new Error(message); }

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires a local value`);
  return value;
}

function expandHome(value, homeDirectory) {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory, value.slice(2));
  return value;
}

function statusPassthroughIsLocalOnly(argv) {
  return argv.length === 0 || (argv.length === 2 && argv[0] === '--home');
}

export function parseStableEntryArgs(argv, { env = process.env, homeDirectory = os.homedir() } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('stable-entry argv must be an array');
  const passthrough = [];
  let command = null;
  let manifest = env.DEVBRIDGE_ENTRY_RUNNER_MANIFEST ?? null;
  let publicKey = env.DEVBRIDGE_ENTRY_RUNNER_PUBLIC_KEY ?? null;
  let home = null;
  let releaseMode = 'development';
  let releaseModeSeen = false;
  let noUpdate = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === 'entry-status') {
      if (command != null) fail('Only one permanent-entry command may be supplied.');
      command = value;
      continue;
    }
    if (ENTRY_VALUE_FLAGS.has(value)) {
      const selected = takeValue(argv, index, value);
      if (value === '--entry-runner-manifest') {
        if (manifest != null && manifest !== env.DEVBRIDGE_ENTRY_RUNNER_MANIFEST) fail('Only one entry runner manifest may be supplied.');
        manifest = selected;
      } else {
        if (publicKey != null && publicKey !== env.DEVBRIDGE_ENTRY_RUNNER_PUBLIC_KEY) fail('Only one entry runner public key may be supplied.');
        publicKey = selected;
      }
      index += 1;
      continue;
    }
    if (value === '--home') {
      const selected = takeValue(argv, index, value);
      if (home != null) fail('Only one --home value may be supplied.');
      home = selected;
      passthrough.push(value, selected);
      index += 1;
      continue;
    }
    if (value === '--release-mode') {
      const selected = takeValue(argv, index, value);
      if (releaseModeSeen) fail('Only one --release-mode value may be supplied.');
      if (!['development', 'production'].includes(selected)) fail('--release-mode must be development or production');
      releaseModeSeen = true;
      releaseMode = selected;
      passthrough.push(value, selected);
      index += 1;
      continue;
    }
    if (value === '--no-update') noUpdate = true;
    passthrough.push(value);
  }

  const configuredHome = home ?? env.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  const resolvedHome = path.resolve(expandHome(String(configuredHome), homeDirectory));
  if (command != null && !statusPassthroughIsLocalOnly(passthrough)) fail('entry-status cannot be combined with runtime arguments');
  if (releaseMode !== 'production' && (manifest != null || publicKey != null)) {
    fail('entry runner signing inputs require --release-mode production');
  }

  return Object.freeze({
    command,
    argv: Object.freeze([...passthrough]),
    home: resolvedHome,
    releaseMode,
    noUpdate,
    manifest: manifest == null ? null : path.resolve(expandHome(String(manifest), homeDirectory)),
    publicKey: publicKey == null ? null : path.resolve(expandHome(String(publicKey), homeDirectory)),
  });
}

async function boundedLocalFile(file, name, limit) {
  if (file == null) fail(`${name} is not configured`);
  if (!path.isAbsolute(file)) fail(`${name} must be an absolute local path`);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) fail(`${name} must be a bounded real file`);
  const actual = await realpath(file);
  const bytes = await readFile(actual);
  if (bytes.length < 1 || bytes.length > limit) fail(`${name} is outside its bounded size`);
  return bytes;
}

function fileSource(file, name, limit) {
  return Object.freeze({ async read() { return boundedLocalFile(file, name, limit); } });
}

function offlineSource() {
  return Object.freeze({ async read() { fail('runner refresh is disabled by --no-update'); } });
}

class AcceptedOnlyAuthority {
  #state;
  #mode;

  constructor(state, mode) { this.#state = state; this.#mode = mode; }

  async resolve(selector) {
    if (!selector || selector.kind !== 'channel' || selector.value !== 'stable') fail('accepted-only authority requires stable selector');
    const subject = await this.#state.preferred(this.#mode);
    if (!subject) fail(`--no-update requires an accepted ${this.#mode} stable runner`);
    return subject;
  }

  async recover(failedSubject) { return this.#state.fallback(failedSubject, this.#mode); }

  async accept(subject) {
    const state = await this.#state.read();
    if (!state) fail('accepted stable runner state disappeared before launch');
    const allowed = [state.current, state.previous].some((record) =>
      record?.mode === this.#mode && sameRunnerSubject(record.subject, subject));
    if (!allowed) fail('accepted stable runner authority changed before launch');
    return state;
  }
}

export function stableEntryPaths(home) {
  const root = path.resolve(home);
  return Object.freeze({
    stateRoot: path.join(root, 'entry', 'state'),
    cacheRoot: path.join(root, 'entry', 'cache'),
  });
}

export async function stableEntryStatus(home, { state = null } = {}) {
  const paths = stableEntryPaths(home);
  const stableState = state ?? new StableRunnerState({ stateRoot: paths.stateRoot });
  return Object.freeze({
    protocol: ENTRY_STATUS_PROTOCOL,
    installationTag: await entryInstallationTag(home),
    permanentEntryProtocol: PERMANENT_ENTRY_PROTOCOL,
    stable: await stableState.status(),
  });
}

export async function runStableEntry(argv, {
  env = process.env,
  homeDirectory = os.homedir(),
  source = null,
  state = null,
  subjectAuthority = null,
  runnerProvider = null,
  write = (text) => process.stdout.write(text),
} = {}) {
  const args = parseStableEntryArgs(argv, { env, homeDirectory });
  const paths = stableEntryPaths(args.home);
  const stableState = state ?? new StableRunnerState({ stateRoot: paths.stateRoot });
  if (args.command === 'entry-status') {
    write(`${JSON.stringify(await stableEntryStatus(args.home, { state: stableState }))}\n`);
    return 0;
  }

  const fixedSource = source ?? new GitHubRunnerSource();
  let authority = subjectAuthority;
  if (authority == null) {
    if (args.noUpdate) {
      authority = new AcceptedOnlyAuthority(stableState, args.releaseMode);
    } else if (args.releaseMode === 'production') {
      authority = new ProductionStableSubjectAuthority({
        manifestSource: fileSource(args.manifest, 'entry runner manifest', MAX_MANIFEST_BYTES),
        publicKeySource: fileSource(args.publicKey, 'entry runner public key', MAX_KEY_BYTES),
        state: stableState,
      });
    } else {
      authority = new DevelopmentStableSubjectAuthority({ source: fixedSource, state: stableState });
    }
  }

  const providerSource = args.noUpdate ? offlineSource() : fixedSource;
  const provider = runnerProvider ?? new ContentAddressedRunnerProvider({ source: providerSource, cacheRoot: paths.cacheRoot });
  return runPermanentEntry(args.argv, { subjectAuthority: authority, runnerProvider: provider });
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const status = await runStableEntry(process.argv.slice(2));
    if (Number.isInteger(status)) process.exitCode = status;
  } catch (error) {
    process.stderr.write(`[devbridge-entry] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
