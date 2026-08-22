import { execFile, spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function inspectVersion(executable) {
  const result = await execute(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024, windowsHide: true });
  const value = String(result.stdout || result.stderr || '').trim().split(/\r?\n/u)[0] ?? '';
  if (!value || value.length > 256 || value.includes('\0')) throw new Error('zstd version output is invalid');
  return value;
}
function runProcess(executable, args, outputFile) {
  return new Promise(async (resolve, reject) => {
    let output;
    try { output = await open(outputFile, 'wx', 0o600); } catch (error) { reject(error); return; }
    let child; let stderr = '';
    try { child = spawn(executable, args, { stdio: ['ignore', output.fd, 'pipe'], shell: false, windowsHide: true }); }
    catch (error) { await output.close().catch(() => {}); reject(error); return; }
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', async (error) => { await output.close().catch(() => {}); reject(error); });
    child.once('close', async (code) => { await output.close().catch(() => {}); if (code !== 0) reject(new Error((stderr || `image codec exited ${code}`).trim().slice(-2048))); else resolve(); });
  });
}

export class ZstdImageCodec {
  algorithm = 'zstd';
  #executable; #level; #version; #run; #inspect;
  constructor({ executable = 'zstd', level = 9, version = null, run = runProcess, inspect = inspectVersion } = {}) {
    if (typeof executable !== 'string' || executable.length === 0) throw new TypeError('zstd executable is required');
    if (!Number.isInteger(level) || level < 1 || level > 19) throw new TypeError('zstd level must be between 1 and 19');
    if (version != null && (typeof version !== 'string' || version.length === 0 || version.length > 256 || version.includes('\0'))) throw new TypeError('zstd version identity is invalid');
    if (typeof run !== 'function' || typeof inspect !== 'function') throw new TypeError('zstd process contract is invalid');
    this.#executable = executable; this.#level = level; this.#version = version; this.#run = run; this.#inspect = inspect;
  }
  async describe() {
    const version = this.#version ?? await this.#inspect(this.#executable);
    return Object.freeze({ algorithm: this.algorithm, parameters: Object.freeze({ checksum: '1', level: String(this.#level), threads: '1', version }) });
  }
  async encode({ source, destination }) {
    const input = path.resolve(source); const output = path.resolve(destination);
    try { await this.#run(this.#executable, ['--quiet', '--threads=1', '--check', `-${this.#level}`, '--stdout', input], output); }
    catch (error) { await rm(output, { force: true }).catch(() => {}); throw error; }
  }
  async decode({ source, destination, algorithm }) {
    if (algorithm !== this.algorithm) throw new Error('zstd decoder received another encoding algorithm');
    const input = path.resolve(source); const output = path.resolve(destination);
    try { await this.#run(this.#executable, ['--quiet', '--decompress', '--stdout', input], output); }
    catch (error) { await rm(output, { force: true }).catch(() => {}); throw error; }
  }
}
