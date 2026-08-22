import { lstat, realpath } from 'node:fs/promises';
import { createHyperVEnvironmentLocation } from './hyperv-environment-location.js';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

function encodeScript(value) { return Buffer.from(value, 'utf16le').toString('base64'); }
function bounded(value, name, maxBytes = 4096) { if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`); return value; }

const COPY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
if ([string]$item.State -ne 'Running') { throw 'environment is not running' }
$service = Get-VMIntegrationService -VMName ([string]$data.reference) -ErrorAction Stop | Where-Object { $_.Name -eq 'Guest Service Interface' } | Select-Object -First 1
if ($null -eq $service -or -not $service.Enabled) { throw 'guest file service is not enabled' }
Copy-VMFile -VMName ([string]$data.reference) -SourcePath ([string]$data.source) -DestinationPath ([string]$data.destination) -FileSource Host -CreateFullPath -Force -ErrorAction Stop
@{ delivered = $true } | ConvertTo-Json -Compress
`;

export class HyperVGuestFileDelivery {
  #invoke;
  #location;
  constructor({ identity, invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('guest file delivery invocation contract is invalid');
    this.#invoke = invoke;
    this.#location = createHyperVEnvironmentLocation(identity);
  }

  async put(rawTarget, source, destination) {
    const target = bounded(rawTarget, 'guest file delivery target', 512);
    if (!TARGET.test(target)) throw new TypeError('guest file delivery target is invalid');
    const lexical = bounded(source, 'guest file delivery source');
    const info = await lstat(lexical);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('guest file delivery source must be a real regular file');
    const localSource = await realpath(lexical);
    const guestDestination = bounded(destination, 'guest file delivery destination');
    const location = this.#location.environment(target);
    const result = await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodeScript(COPY_SCRIPT)],
      input: JSON.stringify({ ...location, source: localSource, destination: guestDestination }),
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error(String(result?.stderr || result?.stdout || 'guest file delivery failed').trim().slice(0, 2048));
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('guest file delivery returned invalid structured output'); }
    if (parsed?.delivered !== true) throw new Error('guest file delivery did not report completion');
    return Object.freeze({ delivered: true });
  }
}
