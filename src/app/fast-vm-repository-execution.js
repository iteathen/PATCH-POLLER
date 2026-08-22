import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createExecutionProfileRepositoryExecution } from './execution-profile-routing.js';
import { createFastPersistentEnvironmentChannel } from './fast-persistent-environment-channel.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { ExecutionProfileResourceError } from '../runtime/profile-resource-preflight.js';

const TARGET = /^env-[a-f0-9]{32}$/u;
const PROVIDER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const STATE_PROTOCOL = 'devbridge/hyperv-persistent-environment-v1';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const FAST_AGENT_LOCATION = Object.freeze({ class: 'input', path: 'control/fast-exchange-agent.mjs' });
const FAST_AGENT_PATH = '/var/lib/devbridge/bridge/input/control/fast-exchange-agent.mjs';
const BRIDGE_AGENT_FILE = fileURLToPath(new URL('../guest/bridge-agent.mjs', import.meta.url));

function bufferPort(bytes) {
  const value = Buffer.from(bytes);
  return { async read({ offset, limit }) { const end = Math.min(value.length, offset + limit); return { data: value.subarray(offset, end), eof: end === value.length }; } };
}

function encodeScript(value) {
  return Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${value}`, 'utf16le').toString('base64');
}

function structuredResourceFailure(result) {
  const text = String(result?.stdout ?? '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value?.error !== 'PROFILE_RESOURCES_UNAVAILABLE') return null;
    return new ExecutionProfileResourceError({
      resource: String(value.resource ?? 'memory'),
      requestedBytes: Number(value.requestedBytes),
      availableBytes: Number(value.availableBytes),
      reserveBytes: Number(value.reserveBytes),
    });
  } catch (error) {
    if (error instanceof ExecutionProfileResourceError) return error;
    return null;
  }
}

function parseResult(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const resourceFailure = structuredResourceFailure(result);
    if (resourceFailure) throw resourceFailure;
    const detail = result?.stderr?.trim() || result?.stdout?.trim() || 'fast VM topology operation failed';
    throw new Error(detail.slice(-2_048));
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error('fast VM topology operation returned invalid structured output'); }
}

const ATTACH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'fast VM provider identity does not match' }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'fast VM ownership evidence does not match' }
$switch = Get-VMSwitch -Name ([string]$data.switchName) -ErrorAction Stop
$adapters = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
if ($adapters.Count -eq 0) {
  $adapter = Add-VMNetworkAdapter -VMName ([string]$data.name) -Name 'Network Adapter' -SwitchName ([string]$data.switchName) -Passthru -ErrorAction Stop
} elseif ($adapters.Count -eq 1) {
  $adapter = $adapters[0]
  if ([string]$adapter.SwitchName -ne [string]$data.switchName) { Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -VMSwitch $switch -ErrorAction Stop }
} else {
  throw 'fast VM network adapter count is incompatible'
}
$copy = Get-VMIntegrationService -VMName ([string]$data.name) -ErrorAction Stop | Where-Object { $_.Name -eq 'Guest Service Interface' } | Select-Object -First 1
if ($null -eq $copy) { throw 'fast VM guest file service is unavailable' }
if (-not $copy.Enabled) { Enable-VMIntegrationService -VMIntegrationService $copy -ErrorAction Stop | Out-Null }
$state = [string]$item.State
if ($state -eq 'Off' -or $state -eq 'Saved') {
  $startupBytes = [long]$item.MemoryStartup
  $hostState = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  $availableBytes = [long]$hostState.FreePhysicalMemory * 1024
  $reserveBytes = [long][Math]::Max(536870912, [Math]::Ceiling($startupBytes / 4.0))
  if ($availableBytes -lt ($startupBytes + $reserveBytes)) {
    @{
      error = 'PROFILE_RESOURCES_UNAVAILABLE'
      resource = 'memory'
      requestedBytes = $startupBytes
      availableBytes = $availableBytes
      reserveBytes = $reserveBytes
    } | ConvertTo-Json -Compress
    exit 23
  }
  Start-VM -Name ([string]$data.name) -ErrorAction Stop | Out-Null
} elseif ($state -eq 'Paused') {
  Resume-VM -Name ([string]$data.name) -ErrorAction Stop | Out-Null
} elseif ($state -ne 'Running') {
  throw "fast VM state is not attachable: $state"
}
$current = Get-VM -Name ([string]$data.name) -ErrorAction Stop
$adapter = Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop | Select-Object -First 1
$hostNetworks = @(
  Get-NetIPAddress -InterfaceAlias ("vEthernet ({0})" -f ([string]$data.switchName)) -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { ([string]$_.AddressState) -notin @('Invalid', 'Duplicate', 'Tentative') } |
    ForEach-Object { @{ address = [string]$_.IPAddress; prefixLength = [int]$_.PrefixLength } }
)
@{
  state = ([string]$current.State).ToLowerInvariant()
  addresses = if ([string]$current.State -eq 'Running') { @($adapter.IPAddresses) } else { @() }
  hostNetworks = $hostNetworks
} | ConvertTo-Json -Compress -Depth 4
`;

function ipv4Number(value) {
  const match = String(value).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((entry) => entry < 0 || entry > 255)) return null;
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function onHostNetwork(address, rawNetwork) {
  const candidate = ipv4Number(address);
  const host = ipv4Number(rawNetwork?.address);
  const prefixLength = rawNetwork?.prefixLength;
  if (candidate == null || host == null || !Number.isSafeInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) return false;
  const mask = prefixLength === 32 ? 0xffffffff : (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((candidate & mask) >>> 0) === ((host & mask) >>> 0);
}

export function selectFastVmAddress(addresses, hostNetworks) {
  if (!Array.isArray(addresses) || !Array.isArray(hostNetworks)) return null;
  return addresses
    .map(String)
    .find((entry) => {
      const value = ipv4Number(entry);
      if (value == null || entry.startsWith('127.') || entry.startsWith('169.254.')) return false;
      return hostNetworks.some((network) => onHostNetwork(entry, network));
    }) ?? null;
}

async function providerRecord(stateDirectory, target) {
  if (typeof target !== 'string' || !TARGET.test(target)) throw new TypeError('fast VM target is invalid');
  const file = path.join(path.resolve(stateDirectory), 'environment-foundation', 'persistent', 'operations', 'state.json');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('fast VM provider state is invalid');
  const state = JSON.parse(await readFile(file, 'utf8'));
  if (!state || state.protocol !== STATE_PROTOCOL || !state.records) throw new Error('fast VM provider state protocol is invalid');
  const record = state.records[target];
  if (!record || record.identity !== target || typeof record.name !== 'string' || typeof record.marker !== 'string' || !PROVIDER_ID.test(String(record.providerIdentity ?? ''))) {
    throw new Error('fast VM provider record is unavailable');
  }
  return {
    name: record.name,
    marker: record.marker,
    providerIdentity: String(record.providerIdentity),
  };
}

export function createFastVmTopology({
  stateDirectory,
  invoke = invokeCommand,
  access = async () => ({ family: 'linux' }),
  switchName = 'Default Switch',
  cacheMs = 30_000,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('fast VM stateDirectory is required');
  if (typeof invoke !== 'function' || typeof access !== 'function') throw new TypeError('fast VM topology composition is incomplete');
  if (typeof switchName !== 'string' || switchName.length === 0) throw new TypeError('fast VM switch name is required');
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 5 * 60_000) throw new TypeError('fast VM topology cache duration is invalid');

  const cachedConnections = new Map();

  const observe = async (target) => {
    const record = await providerRecord(stateDirectory, target);
    return parseResult(await invoke({
      executable: 'powershell.exe',
      arguments: [...POWERSHELL_ARGS, encodeScript(ATTACH_SCRIPT)],
      input: JSON.stringify({ ...record, switchName }),
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    }));
  };

  const connection = async (target) => {
    const cached = cachedConnections.get(target);
    if (cached && cached.expiresAt > Date.now()) {
      const base = await access(target);
      if (!base || base.family !== 'linux') throw new Error('fast VM route must use Linux guest access');
      return { ...base, address: cached.address };
    }
    const deadline = Date.now() + 90_000;
    let last = null;
    do {
      try {
        const result = await observe(target);
        const address = selectFastVmAddress(result.addresses, result.hostNetworks);
        if (address) {
          const base = await access(target);
          if (!base || base.family !== 'linux') throw new Error('fast VM route must use Linux guest access');
          const resolved = String(address);
          cachedConnections.set(target, { address: resolved, expiresAt: Date.now() + cacheMs });
          return { ...base, address: resolved };
        }
        last = new Error('fast VM has no address on the selected host switch network');
      } catch (error) {
        last = error;
        if (error instanceof ExecutionProfileResourceError) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);
    throw new Error(`fast VM connection did not become ready: ${last?.message ?? 'unknown failure'}`);
  };

  return Object.freeze({
    connection,
    async ensure(target) {
      const current = await connection(target);
      return { ready: true, generation: 'fast-default-switch-v1', address: current.address };
    },
  });
}

export async function createFastVmRepositoryExecution(options = {}) {
  const createState = async ({ stateDirectory, platform, invoke }) => {
    const foundation = await createEnvironmentFoundation({ stateDirectory, platform, invoke });
    return Object.freeze({
      async inspect() {
        const status = await foundation.inspect();
        const required = ['management', 'images', 'storage'].every((name) => status.capabilities?.[name]?.ready === true);
        return required ? { ...status, state: 'ready', ready: true, reason: null } : status;
      },
      listEnvironments: () => foundation.listEnvironments(),
      observeEnvironment: (target) => foundation.observeEnvironment(target),
    });
  };
  const createPreparation = async ({ stateDirectory, invoke, access }) => createFastVmTopology({ stateDirectory, invoke, access });
  const createChannel = async ({ stateDirectory, platform, invoke, access }) => {
    const bridge = await createEnvironmentBridge({ stateDirectory, platform, invoke, access });
    const agentBytes = await readFile(BRIDGE_AGENT_FILE);
    return createFastPersistentEnvironmentChannel({
      access,
      agentPath: FAST_AGENT_PATH,
      prepare: (target) => bridge.put(target, bufferPort(agentBytes), FAST_AGENT_LOCATION, { maxBytes: agentBytes.length }),
    });
  };
  return createExecutionProfileRepositoryExecution({ ...options, createState, createPreparation, createChannel });
}
