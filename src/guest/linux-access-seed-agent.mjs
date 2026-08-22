import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const LINUX_ACCESS_SEED_PROTOCOL = 'devbridge/linux-access-seed-v1';
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]{40,256}(?: [^\r\n]{0,128})?$/u;
const PRIVATE_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const MAX_SEED_BYTES = 128 * 1024;
const DEFAULT_SEED = '/var/lib/devbridge/access/seed.json';
const DEFAULT_STATE = '/var/lib/devbridge/access/state.json';

function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`); return value; }
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function publicKey(value, name) { const normalized = String(value ?? '').trim(); if (!PUBLIC_KEY.test(normalized)) throw new TypeError(`${name} is invalid`); return normalized; }
function privateKey(value) { const normalized = String(value ?? ''); if (!normalized.startsWith(PRIVATE_HEADER) || normalized.includes('\0') || Buffer.byteLength(normalized, 'utf8') > 64 * 1024) throw new TypeError('Linux access host private key is invalid'); return normalized; }

export function normalizeLinuxAccessSeed(raw) {
  const value = requireObject(raw, 'Linux access seed');
  onlyKeys(value, new Set(['protocol', 'target', 'user', 'authorizedKey', 'hostPrivateKey', 'hostPublicKey', 'revision']), 'Linux access seed');
  if (value.protocol !== LINUX_ACCESS_SEED_PROTOCOL) throw new TypeError('Linux access seed protocol is unsupported');
  if (typeof value.target !== 'string' || !TARGET.test(value.target)) throw new TypeError('Linux access seed target is invalid');
  if (value.user !== 'devbridge') throw new TypeError('Linux access seed user is unsupported');
  if (value.revision !== 1) throw new TypeError('Linux access seed revision is unsupported');
  return Object.freeze({
    protocol: LINUX_ACCESS_SEED_PROTOCOL,
    target: value.target,
    user: 'devbridge',
    authorizedKey: publicKey(value.authorizedKey, 'Linux access authorized key'),
    hostPrivateKey: privateKey(value.hostPrivateKey),
    hostPublicKey: publicKey(value.hostPublicKey, 'Linux access host public key'),
    revision: 1,
  });
}

function seedDigest(seed) { return createHash('sha256').update(JSON.stringify(seed), 'utf8').digest('hex'); }
function publicDigest(key) { return createHash('sha256').update(key, 'utf8').digest('hex'); }

function invoke(executable, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let settled = false;
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    const timer = setTimeout(() => { if (settled) return; settled = true; child.kill('SIGKILL'); reject(new Error(`${executable} timed out`)); }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.once('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) reject(new Error((stderr || stdout || `${executable} exited ${code}`).trim().slice(-2048))); else resolve({ stdout, stderr }); });
  });
}

async function realDirectory(directory, mode) {
  await mkdir(directory, { recursive: true, mode });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Linux access directory is not a real directory: ${directory}`);
}

async function atomic(file, content, mode) {
  const directory = path.dirname(file);
  await realDirectory(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function installLinuxAccess(seed, {
  home = '/home/devbridge',
  hostKey = '/etc/ssh/ssh_host_ed25519_key',
  invokeCommand = invoke,
} = {}) {
  const value = normalizeLinuxAccessSeed(seed);
  const sshDirectory = path.join(home, '.ssh');
  await realDirectory(sshDirectory, 0o700);
  await atomic(path.join(sshDirectory, 'authorized_keys'), `${value.authorizedKey}\n`, 0o600);
  await atomic(hostKey, `${value.hostPrivateKey.trimEnd()}\n`, 0o600);
  await atomic(`${hostKey}.pub`, `${value.hostPublicKey}\n`, 0o644);
  await invokeCommand('chown', ['-R', 'devbridge:devbridge', sshDirectory]);
  await invokeCommand('systemctl', ['restart', 'ssh']);
  return Object.freeze({ target: value.target, seedSha256: seedDigest(value), hostPublicSha256: publicDigest(value.hostPublicKey), authorizedPublicSha256: publicDigest(value.authorizedKey) });
}

async function loadSeed(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SEED_BYTES) throw new Error('Linux access seed must be a bounded real file');
  return normalizeLinuxAccessSeed(JSON.parse(await readFile(file, 'utf8')));
}

async function loadState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function applyLinuxAccessSeed({ seedFile = DEFAULT_SEED, stateFile = DEFAULT_STATE, install = installLinuxAccess } = {}) {
  const seed = await loadSeed(seedFile);
  const digest = seedDigest(seed);
  const current = await loadState(stateFile);
  if (current?.protocol === LINUX_ACCESS_SEED_PROTOCOL && current.target === seed.target && current.seedSha256 === digest) {
    await rm(seedFile, { force: true });
    return Object.freeze({ changed: false, target: seed.target });
  }
  const result = await install(seed);
  await atomic(stateFile, `${JSON.stringify({ protocol: LINUX_ACCESS_SEED_PROTOCOL, ...result, appliedAt: new Date().toISOString() })}\n`, 0o600);
  await rm(seedFile, { force: true });
  return Object.freeze({ changed: true, target: seed.target });
}

if (process.argv.includes('--once')) {
  await applyLinuxAccessSeed();
} else if (process.argv.includes('--watch')) {
  while (true) {
    try { await applyLinuxAccessSeed(); }
    catch (error) { if (error?.code !== 'ENOENT') process.stderr.write(`Linux access seed apply failed: ${String(error?.message ?? error).slice(0, 2048)}\n`); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
