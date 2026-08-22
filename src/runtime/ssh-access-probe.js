import { lstat, realpath } from 'node:fs/promises';

const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
function executable(platform) { return platform === 'win32' ? 'ssh.exe' : 'ssh'; }
async function regular(value, name) { if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`); const info = await lstat(value); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`); return realpath(value); }

export class SshAccessProbe {
  #invoke; #executable;
  constructor({ invoke, executable: selected = executable(process.platform) } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('SSH access probe invocation contract is invalid');
    if (typeof selected !== 'string' || selected.length === 0) throw new TypeError('SSH access probe executable is invalid');
    this.#invoke = invoke; this.#executable = selected;
  }
  async inspect(access) {
    if (!access || access.family !== 'linux' || typeof access.user !== 'string' || !USER.test(access.user) || typeof access.address !== 'string' || !ADDRESS.test(access.address)) return Object.freeze({ ready: false, reason: 'SSH access endpoint is invalid' });
    let identityFile; let knownHostsFile;
    try { [identityFile, knownHostsFile] = await Promise.all([regular(access.identityFile, 'SSH access identityFile'), regular(access.knownHostsFile, 'SSH access knownHostsFile')]); }
    catch (error) { return Object.freeze({ ready: false, reason: error.message }); }
    const result = await this.#invoke({
      executable: this.#executable,
      arguments: [
        '-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-T',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', `GlobalKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
        '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'ConnectTimeout=5', '-i', identityFile, `${access.user}@${access.address}`, 'true',
      ],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) return Object.freeze({ ready: false, reason: String(result?.stderr || result?.stdout || 'SSH access probe failed').trim().slice(-1024) });
    return Object.freeze({ ready: true, reason: null });
  }
}
