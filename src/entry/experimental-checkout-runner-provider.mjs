import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { RUNNER_SUBJECT_PROTOCOL } from './permanent-entry.mjs';

const FIXED_REMOTE = 'https://github.com/iteathen/DevBridge.git';
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_ENTRY_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 256 * 1024;
const PUBLISH_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const PUBLISH_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80, 160]);
const CHECKOUT_ID_DOMAIN = 'devbridge/experimental-checkout-cache-v1';

function fail(message) { throw new Error(message); }

function normalizeSubject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.protocol !== RUNNER_SUBJECT_PROTOCOL) {
    fail('experimental checkout subject is invalid');
  }
  const head = String(input.head ?? '').toLowerCase();
  const sha256 = String(input.sha256 ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head) || !EXACT_DIGEST.test(sha256)) fail('experimental checkout subject identity is invalid');
  if (input.channel !== 'experimental') fail('experimental checkout provider refuses non-experimental authority');
  return Object.freeze({ ...input, head, sha256 });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkoutIdentity(subject) {
  return createHash('sha256')
    .update(CHECKOUT_ID_DOMAIN)
    .update('\0')
    .update(subject.head)
    .update('\0')
    .update(subject.sha256)
    .digest('hex');
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function requireRealDirectory(candidate, name, { create = false } = {}) {
  if (create) await mkdir(candidate, { recursive: true, mode: 0o700 });
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory`);
  return realpath(candidate);
}

async function requireRegularFile(root, relative, name, maxBytes = MAX_ENTRY_BYTES) {
  const candidate = path.join(root, ...relative.split('/'));
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) fail(`${name} is invalid`);
  const actual = await realpath(candidate);
  const rel = path.relative(root, actual);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`${name} escaped the exact checkout`);
  return { path: actual, bytes: await readFile(actual) };
}

function defaultRun(program, args, { cwd, env }) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  return {
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error ?? null,
  };
}

function defaultLaunch(entry, argv, { cwd, env }) {
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function gitEnvironment(home) {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    : ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  const env = {};
  for (const name of names) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

async function runChecked(run, args, context, label) {
  const result = await run('git', args, context);
  if (!result || result.exitCode !== 0 || result.timedOut === true || result.error) fail(`experimental checkout ${label} failed`);
  return result;
}

async function publishDirectory(temporary, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return 'published';
    } catch (error) {
      if (await exists(destination)) return 'existing';
      const retry = process.platform === 'win32'
        && PUBLISH_RETRY_CODES.has(error?.code)
        && attempt < PUBLISH_RETRY_DELAYS_MS.length;
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export class ExperimentalCheckoutRunnerProvider {
  #root;
  #run;
  #launch;

  constructor({ cacheRoot, run = defaultRun, launch = defaultLaunch } = {}) {
    if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot)) throw new TypeError('experimental checkout cacheRoot must be an absolute local path');
    if (typeof run !== 'function' || typeof launch !== 'function') throw new TypeError('experimental checkout execution ports must be functions');
    this.#root = path.resolve(cacheRoot);
    this.#run = run;
    this.#launch = launch;
  }

  async #context(root) {
    const home = await requireRealDirectory(path.join(root, 'control-home'), 'experimental checkout control home', { create: true });
    const gitconfig = path.join(home, 'gitconfig');
    if (!(await exists(gitconfig))) await writeFile(gitconfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { cwd: root, env: gitEnvironment(home) };
  }

  async #verify(directory, subject, context) {
    const root = await requireRealDirectory(directory, 'experimental checkout');
    const git = path.join(root, '.git');
    const gitInfo = await lstat(git);
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) fail('experimental checkout Git identity is invalid');

    const headResult = await runChecked(this.#run, ['-C', root, 'rev-parse', '--verify', 'HEAD'], context, 'head verification');
    if (headResult.stdout.trim().toLowerCase() !== subject.head) fail('experimental checkout resolved a different exact head');
    const status = await runChecked(this.#run, ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], context, 'cleanliness verification');
    if (status.stdout.trim() !== '') fail('experimental checkout is not clean');

    await requireRegularFile(root, 'devbridge.mjs', 'experimental checkout runner artifact');
    const artifact = await runChecked(
      this.#run,
      ['-C', root, 'cat-file', 'blob', `${subject.head}:devbridge.mjs`],
      context,
      'runner artifact verification',
    );
    if (digest(Buffer.from(artifact.stdout, 'utf8')) !== subject.sha256) fail('experimental checkout runner artifact digest differs from the exact subject');
    const entry = await requireRegularFile(root, 'src/cli.js', 'experimental checkout control-plane entry');
    return { root, entry: entry.path };
  }

  async prepare(input) {
    const subject = normalizeSubject(input);
    const root = await requireRealDirectory(this.#root, 'experimental checkout cache root', { create: true });
    const checkouts = await requireRealDirectory(path.join(root, 'checkouts'), 'experimental checkout object root', { create: true });
    const context = await this.#context(root);
    const identity = checkoutIdentity(subject);
    const destination = path.join(checkouts, identity);

    if (!(await exists(destination))) {
      // Keep transient filesystem names independent of exact identity length.
      // On Windows, embedding head + digest + UUID here can push Git's internal
      // .git/object paths beyond the default MAX_PATH budget during fetch.
      const temporary = path.join(checkouts, `.prepare-${randomUUID()}.tmp`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        await runChecked(this.#run, ['init', '--quiet', temporary], context, 'initialization');
        await runChecked(this.#run, ['-C', temporary, 'remote', 'add', 'origin', FIXED_REMOTE], context, 'source binding');
        await runChecked(this.#run, ['-C', temporary, 'fetch', '--no-tags', '--depth', '1', 'origin', subject.head], context, 'exact fetch');
        await runChecked(this.#run, ['-C', temporary, 'checkout', '--detach', '--force', subject.head], context, 'exact checkout');
        await this.#verify(temporary, subject, context);
        const publication = await publishDirectory(temporary, destination);
        if (publication === 'existing') await rm(temporary, { recursive: true, force: true });
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }

    await this.#verify(destination, subject, context);
    const provider = this;
    return Object.freeze({
      subject,
      async launch(argv) {
        if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) fail('experimental checkout launch argv must be an array of strings');
        const current = await provider.#verify(destination, subject, context);
        return provider.#launch(current.entry, [...argv], { cwd: current.root, env: { ...process.env } });
      },
    });
  }
}
