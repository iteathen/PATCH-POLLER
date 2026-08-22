import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]{40,256}(?: [^\r\n]{0,128})?$/u;
const PRIVATE_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';

function keyExecutable(platform) { return platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'; }
function targetId(value) { if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('SSH access target is invalid'); return value; }
async function regular(file) { try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink(); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
function publicKey(value, name) { const normalized = String(value).trim(); if (!PUBLIC_KEY.test(normalized)) throw new Error(`${name} is invalid`); return normalized; }
function privateKey(value) { const normalized = String(value); if (!normalized.startsWith(PRIVATE_HEADER) || Buffer.byteLength(normalized, 'utf8') > 64 * 1024 || normalized.includes('\0')) throw new Error('SSH private key material is invalid'); return normalized; }

export class SshAccessMaterial {
  #directory; #invoke; #executable; #user;
  constructor({ directory, invoke, executable = keyExecutable(process.platform), user = 'devbridge' } = {}) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('SSH access directory is required');
    if (typeof invoke !== 'function') throw new TypeError('SSH key generation invocation contract is invalid');
    if (typeof executable !== 'string' || executable.length === 0) throw new TypeError('SSH key generation executable is invalid');
    if (typeof user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(user)) throw new TypeError('SSH access user is invalid');
    this.#directory = path.resolve(directory); this.#invoke = invoke; this.#executable = executable; this.#user = user;
  }

  #root(target) { return path.join(this.#directory, createHash('sha256').update(targetId(target), 'utf8').digest('hex').slice(0, 32)); }
  #paths(target) { const root = this.#root(target); return { root, identityFile: path.join(root, 'client_ed25519'), publicFile: path.join(root, 'client_ed25519.pub'), knownHostsFile: path.join(root, 'known_hosts') }; }

  connection(target) {
    const paths = this.#paths(target);
    return Object.freeze({ family: 'linux', user: this.#user, identityFile: paths.identityFile, knownHostsFile: paths.knownHostsFile });
  }

  async #generate(base) {
    const result = await this.#invoke({ executable: this.#executable, arguments: ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', base], input: null, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error(String(result?.stderr || result?.stdout || 'SSH key generation failed').trim().slice(0, 2048));
    if (!await regular(base) || !await regular(`${base}.pub`)) throw new Error('SSH key generation did not produce the expected pair');
  }

  async #ensureClient(paths) {
    const hasPrivate = await regular(paths.identityFile); const hasPublic = await regular(paths.publicFile);
    if (hasPrivate && hasPublic) {
      privateKey(await readFile(paths.identityFile, 'utf8'));
      publicKey(await readFile(paths.publicFile, 'utf8'), 'SSH client public key');
      return;
    }
    if (hasPrivate !== hasPublic) throw new Error('SSH client key material is incomplete; refusing implicit replacement');
    const temporary = path.join(paths.root, `.client-${randomUUID()}`);
    try {
      await this.#generate(temporary);
      privateKey(await readFile(temporary, 'utf8'));
      publicKey(await readFile(`${temporary}.pub`, 'utf8'), 'SSH client public key');
      await rename(temporary, paths.identityFile);
      await rename(`${temporary}.pub`, paths.publicFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(`${temporary}.pub`, { force: true }).catch(() => {});
    }
  }

  async prepare(target) {
    const selected = targetId(target);
    const paths = this.#paths(selected);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(paths.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('SSH access directory must be a real directory');
    await this.#ensureClient(paths);
    const hostBase = path.join(paths.root, `.host-${randomUUID()}`);
    const seedFile = path.join(paths.root, `.seed-${randomUUID()}.json`);
    try {
      await this.#generate(hostBase);
      const authorizedKey = publicKey(await readFile(paths.publicFile, 'utf8'), 'SSH client public key');
      const hostPublicKey = publicKey(await readFile(`${hostBase}.pub`, 'utf8'), 'SSH host public key');
      const hostPrivateKey = privateKey(await readFile(hostBase, 'utf8'));
      const knownHost = `* ${hostPublicKey.split(/\s+/u).slice(0, 2).join(' ')}\n`;
      const knownTemporary = path.join(paths.root, `.known-${randomUUID()}.tmp`);
      await writeFile(knownTemporary, knownHost, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(knownTemporary, paths.knownHostsFile);
      const seed = {
        protocol: 'devbridge/linux-access-seed-v1',
        target: selected,
        user: this.#user,
        authorizedKey,
        hostPrivateKey,
        hostPublicKey,
        revision: 1,
      };
      await writeFile(seedFile, `${JSON.stringify(seed)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return Object.freeze({
        seedFile,
        connection: this.connection(selected),
        async cleanup() {
          await rm(seedFile, { force: true }).catch(() => {});
          await rm(hostBase, { force: true }).catch(() => {});
          await rm(`${hostBase}.pub`, { force: true }).catch(() => {});
        },
      });
    } catch (error) {
      await rm(seedFile, { force: true }).catch(() => {});
      await rm(hostBase, { force: true }).catch(() => {});
      await rm(`${hostBase}.pub`, { force: true }).catch(() => {});
      throw error;
    }
  }
}
