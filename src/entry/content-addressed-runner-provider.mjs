import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_RUNNER_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }

function normalizedSubject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('runner provider subject is invalid');
  const head = String(input.head ?? '').toLowerCase();
  const sha256 = String(input.sha256 ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head) || !EXACT_DIGEST.test(sha256)) fail('runner provider subject identity is invalid');
  return { ...input, head, sha256 };
}

function bytesDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_RUNNER_BYTES) {
    fail('runner provider artifact bytes are invalid');
  }
  return Buffer.from(value);
}

async function realDirectory(directory, name) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory`);
  return realpath(directory);
}

async function verifiedObject(file, digest) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RUNNER_BYTES) return null;
  const bytes = await readFile(file);
  return bytesDigest(bytes) === digest ? bytes : null;
}

function defaultLaunch(file, argv) {
  const result = spawnSync(process.execPath, [file, ...argv], {
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export class ContentAddressedRunnerProvider {
  #source;
  #root;
  #launch;

  constructor({ source, cacheRoot, launch = defaultLaunch } = {}) {
    if (!source || typeof source.read !== 'function') throw new TypeError('runner provider source.read must be a function');
    if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot)) throw new TypeError('runner provider cacheRoot must be an absolute local path');
    if (typeof launch !== 'function') throw new TypeError('runner provider launch must be a function');
    this.#source = source;
    this.#root = path.resolve(cacheRoot);
    this.#launch = launch;
  }

  async prepare(input) {
    const subject = normalizedSubject(input);
    const root = await realDirectory(this.#root, 'runner cache root');
    const objects = await realDirectory(path.join(root, 'objects'), 'runner object root');
    const file = path.join(objects, `${subject.sha256}.mjs`);

    let bytes = await verifiedObject(file, subject.sha256);
    if (!bytes) {
      try { await rm(file, { force: true }); } catch {}
      const fetched = boundedBytes(await this.#source.read(subject.head));
      if (bytesDigest(fetched) !== subject.sha256) fail('runner provider fetched bytes do not match the exact subject');

      const temporary = path.join(objects, `.${subject.sha256}.${randomUUID()}.tmp`);
      await writeFile(temporary, fetched, { flag: 'wx', mode: 0o700 });
      try {
        await link(temporary, file);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      bytes = await verifiedObject(file, subject.sha256);
      if (!bytes) fail('runner provider could not commit a verified content-addressed object');
    }

    const provider = this;
    return Object.freeze({
      subject: Object.freeze({ ...subject }),
      launch(argv) {
        if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) fail('runner launch argv must be an array of strings');
        return provider.#launch(file, [...argv]);
      },
    });
  }
}
