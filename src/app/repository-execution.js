import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironmentBootstrap } from './environment-bootstrap.js';
import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { RepositoryEnvironmentExecution } from '../runtime/repository-environment-execution.js';
import {
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  UnavailableRepositoryExecution,
} from '../runtime/repository-execution.js';
import {
  FILE_TREE_PART_BYTES,
  applyStagedFileTreeDelta,
  normalizeFileTreeDelta,
  snapshotFileTree,
  stageFileTreeDelta,
} from '../runtime/file-tree-transfer.js';

export const ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL = 'devbridge/environment-execution-routes-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.+-]{0,159}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_ROUTE_BYTES = 1024 * 1024;
const MAX_ROUTES = 256;
const BRIDGE_OUTPUT_LIMIT = 3 * 1024 * 1024;
const TRANSFER_LIMIT = 16 * 1024 * 1024;
const MANIFEST_LIMIT = 24 * 1024 * 1024;
const TOOL_RESOURCE_LIMIT = 4 * 1024 * 1024;
const TOOL_RESOURCE_COUNT = 32;
const AGENT_FILE = fileURLToPath(new URL('../guest/workspace-agent.mjs', import.meta.url));
const RESOURCE_AGENT_FILE = fileURLToPath(new URL('../guest/resource-agent.mjs', import.meta.url));

function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`); return value; }
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function stableSubject(value, name) { if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new TypeError(`${name} must be a numeric stable identity`); return value; }
function bounded(value, name, maxBytes = 4096) { if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`); return value; }
function hashIdentity(value) { return `execution-${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`; }
function repositoryPathAllowed(relative) { const first = String(relative).replace(/\\/gu, '/').split('/')[0]; return first !== '.git' && first !== '.devbridge'; }
function splitNul(text) { return String(text).split('\0').filter(Boolean); }
function ensureActive(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('execution control signal was raised');
}

async function acquireExclusiveSession(directory, identity) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(String(identity), 'utf8').digest('hex');
  const file = path.join(directory, `${key}.lock`);
  const token = randomUUID();
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('the selected execution environment already has an active session');
    throw error;
  }
  try { await handle.writeFile(`${token}\n`, 'utf8'); }
  finally { await handle.close(); }
  let released = false;
  return async () => {
    if (released) return;
    const observed = (await readFile(file, 'utf8')).trim();
    if (observed !== token) throw new Error('execution session ownership changed before release');
    await rm(file, { force: false });
    released = true;
  };
}

export function repositoryExecutionRoutesPath(stateDirectory) {
  return path.join(path.resolve(stateDirectory), 'environment-foundation', 'execution-routes.json');
}

function normalizeRouteAccess(raw, index) {
  const value = requireObject(raw, `execution route[${index}].access`);
  onlyKeys(value, new Set(['family', 'username', 'passwordEnvironment', 'user', 'identityFile', 'knownHostsFile']), `execution route[${index}].access`);
  if (!['windows', 'linux'].includes(value.family)) throw new TypeError(`execution route[${index}].access.family is invalid`);
  const result = { family: value.family };
  if (value.username != null) result.username = bounded(value.username, `execution route[${index}].access.username`, 512);
  if (value.passwordEnvironment != null) {
    if (typeof value.passwordEnvironment !== 'string' || !ENV_NAME.test(value.passwordEnvironment)) throw new TypeError(`execution route[${index}].access.passwordEnvironment is invalid`);
    result.passwordEnvironment = value.passwordEnvironment;
  }
  if (value.user != null) result.user = bounded(value.user, `execution route[${index}].access.user`, 256);
  if (value.identityFile != null) result.identityFile = bounded(value.identityFile, `execution route[${index}].access.identityFile`, 4096);
  if (value.knownHostsFile != null) result.knownHostsFile = bounded(value.knownHostsFile, `execution route[${index}].access.knownHostsFile`, 4096);
  return result;
}

export function normalizeEnvironmentExecutionRoutes(raw) {
  const value = requireObject(raw, 'environment execution routes');
  onlyKeys(value, new Set(['protocol', 'routes']), 'environment execution routes');
  if (value.protocol !== ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL) throw new TypeError('environment execution routes protocol is unsupported');
  if (!Array.isArray(value.routes) || value.routes.length > MAX_ROUTES) throw new TypeError('environment execution routes are invalid');
  const seen = new Set();
  const routes = value.routes.map((rawRoute, index) => {
    const route = requireObject(rawRoute, `execution route[${index}]`);
    onlyKeys(route, new Set(['subject', 'profile', 'preferred', 'validation', 'access']), `execution route[${index}]`);
    const normalized = {
      subject: stableSubject(route.subject, `execution route[${index}].subject`),
      profile: safeId(route.profile, `execution route[${index}].profile`),
      preferred: route.preferred === true,
      validation: route.validation === true,
      access: normalizeRouteAccess(route.access, index),
    };
    const key = `${normalized.subject}\0${normalized.profile}`;
    if (seen.has(key)) throw new TypeError('environment execution routes contain a duplicate subject/profile');
    seen.add(key);
    return normalized;
  });
  const preferredBySubject = new Map();
  for (const route of routes) {
    if (!route.preferred) continue;
    if (preferredBySubject.has(route.subject)) throw new TypeError(`environment execution routes contain multiple preferred profiles for ${route.subject}`);
    preferredBySubject.set(route.subject, route.profile);
  }
  const validation = routes.filter((route) => route.validation);
  if (validation.length > 1) throw new TypeError('environment execution routes contain multiple validation routes');
  return Object.freeze({ protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL, routes: Object.freeze(routes.map((route) => Object.freeze({ ...route, access: Object.freeze({ ...route.access }) }))) });
}

export async function loadEnvironmentExecutionRoutes(stateDirectory) {
  const file = repositoryExecutionRoutesPath(stateDirectory);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ROUTE_BYTES) throw new Error('environment execution route file must be a bounded real file');
    return normalizeEnvironmentExecutionRoutes(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function validationEnvironmentExecutionRoute(policy) {
  if (policy == null) throw new Error('no local execution routes are configured');
  const normalized = normalizeEnvironmentExecutionRoutes(policy);
  const matches = normalized.routes.filter((route) => route.validation);
  if (matches.length !== 1) throw new Error('exactly one local validation execution route is required');
  return matches[0];
}

function routeForSubject(policy, subject) {
  const matches = policy.routes.filter((route) => route.subject === subject);
  if (matches.length === 0) throw new Error('no local execution route exists for the repository subject');
  if (matches.length === 1) return matches[0];
  const preferred = matches.filter((route) => route.preferred);
  if (preferred.length !== 1) throw new Error('repository subject has multiple execution profiles and no unique preferred route');
  return preferred[0];
}

function resolvedAccess(route, platform, env) {
  if (platform === 'linux') return { family: route.access.family };
  if (platform !== 'win32') throw new Error('repository execution has no supported host attachment on this platform');
  if (route.access.family === 'windows') {
    if (!route.access.username || !route.access.passwordEnvironment) throw new Error('Windows guest route requires username and passwordEnvironment');
    const password = env[route.access.passwordEnvironment];
    if (typeof password !== 'string' || password.length === 0) throw new Error(`guest access environment ${route.access.passwordEnvironment} is unavailable`);
    return { family: 'windows', username: route.access.username, password };
  }
  if (!route.access.user || !route.access.identityFile || !route.access.knownHostsFile) throw new Error('Linux guest route requires user, identityFile, and knownHostsFile');
  return { family: 'linux', user: route.access.user, identityFile: route.access.identityFile, knownHostsFile: route.access.knownHostsFile };
}

function bufferPort(buffer) {
  const bytes = Buffer.from(buffer);
  return { async read({ offset, limit }) { const end = Math.min(bytes.length, offset + limit); return { data: bytes.subarray(offset, end), eof: end === bytes.length }; } };
}
function memorySink(limit) {
  let value = null;
  return {
    port: { async write({ data, eof }) { if (!eof) throw new Error('buffer sink requires a complete transfer'); const bytes = Buffer.from(data); if (bytes.length > limit) throw new Error('buffer sink exceeded its limit'); value = bytes; } },
    value() { if (value == null) throw new Error('buffer sink did not receive data'); return value; },
  };
}
function executionInput(port) {
  let bytes = null;
  return {
    async read({ offset, limit }) {
      if (bytes == null) bytes = Buffer.from(await port.read());
      const end = Math.min(bytes.length, offset + limit);
      return { data: bytes.subarray(offset, end), eof: end === bytes.length };
    },
  };
}
function executionOutput(port) {
  const chunks = [];
  let offset = 0;
  return {
    async write(frame) {
      const data = Buffer.from(frame?.data ?? frame);
      if (frame?.offset != null && frame.offset !== offset) throw new Error('execution output transfer offset is not contiguous');
      offset += data.length;
      if (offset > TRANSFER_LIMIT) throw new Error('execution output transfer exceeded its limit');
      chunks.push(data);
      if (frame?.eof !== false) await port.write(Buffer.concat(chunks));
    },
  };
}
async function sendBytes(channel, target, bytes, destination) {
  const buffer = Buffer.from(bytes);
  return channel.put(target, bufferPort(buffer), destination, { maxBytes: Math.max(1, buffer.length) });
}
async function receiveBytes(channel, target, source, limit) {
  const sink = memorySink(limit);
  await channel.get(target, source, sink.port, { maxBytes: limit });
  return sink.value();
}
function parseAgentResult(outcome, action) {
  if (!outcome || outcome.completion !== 'observed') throw new Error(`${action} completion is not observed`);
  const result = outcome.result;
  if (!result || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || `${action} failed`).trim().slice(0, 2048));
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${action} returned invalid structured output`); }
}

function descriptorFor(invocation, resolved, environment, stdin, transfers, protectedValues, entryLocation = null, scratchRoot = null) {
  if (!resolved || typeof resolved.program !== 'string' || !SAFE_NAME.test(resolved.program)) throw new Error('logical tool did not resolve to a safe guest program');
  const fixed = resolved.arguments ?? [];
  if (!Array.isArray(fixed) || fixed.some((entry) => typeof entry !== 'string')) throw new Error('logical tool fixed arguments are invalid');
  const locations = [];
  const locationIndex = new Map();
  const locate = (kind, name) => {
    const key = `${kind}:${name}`;
    if (!locationIndex.has(key)) {
      const location = kind === 'scratch'
        ? { class: 'scratch', path: `${scratchRoot}/${name}` }
        : { class: kind, path: `ports/${name}` };
      if (kind === 'scratch' && typeof scratchRoot !== 'string') throw new Error('operation scratch root is unavailable');
      locationIndex.set(key, locations.length);
      locations.push(location);
    }
    return locationIndex.get(key);
  };
  const argumentsList = [];
  if (entryLocation) {
    locations.push(entryLocation);
    argumentsList.push({ kind: 'location', index: 0 });
  }
  argumentsList.push(...fixed.map((value) => ({ kind: 'literal', value })));
  for (const argument of invocation.arguments) {
    if (argument.kind === 'literal') argumentsList.push({ kind: 'literal', value: argument.value });
    else argumentsList.push({ kind: 'location', index: locate(argument.kind, argument.name) });
  }
  const known = new Set(transfers.map((entry) => `${entry.direction}:${entry.name}`));
  for (const argument of invocation.arguments) {
    if (argument.kind === 'literal' || argument.kind === 'scratch') continue;
    if (!known.has(`${argument.kind}:${argument.name}`)) throw new Error('operation argument transfer is not registered');
  }
  for (const value of Object.values(environment)) {
    if (protectedValues.some((protectedValue) => value.includes(protectedValue))) {
      throw new Error('operation environment contains a protected control-plane value');
    }
  }
  return {
    descriptor: { protocol: 'devbridge/work-operation-v1', program: resolved.program, arguments: argumentsList, environment, stdin },
    locations,
  };
}

function resourcePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\\')) throw new Error('tool resource path is invalid');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('/') || normalized.startsWith('../') || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('tool resource path is not a normalized relative path');
  }
  return normalized;
}

async function stageToolResources(channel, target, resolved) {
  const resources = resolved?.resources ?? [];
  if (!Array.isArray(resources) || resources.length > TOOL_RESOURCE_COUNT) throw new Error('logical tool resources are invalid');
  if (resources.length === 0) {
    if (resolved?.entry != null) throw new Error('logical tool entry requires resources');
    return null;
  }
  const normalized = [];
  const paths = new Set();
  let total = 0;
  const digest = createHash('sha256');
  for (const raw of resources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Buffer.isBuffer(raw.bytes)) throw new Error('logical tool resource is invalid');
    const name = resourcePath(raw.path);
    if (paths.has(name)) throw new Error('logical tool resource path is duplicated');
    paths.add(name);
    const bytes = Buffer.from(raw.bytes);
    total += bytes.length;
    if (total > TOOL_RESOURCE_LIMIT) throw new Error('logical tool resources exceed their bound');
    digest.update(name, 'utf8').update('\0').update(bytes).update('\0');
    normalized.push({ name, bytes });
  }
  const entry = resourcePath(resolved.entry);
  if (!paths.has(entry)) throw new Error('logical tool entry is not present in its resources');
  const root = `tools/${digest.digest('hex').slice(0, 32)}`;
  for (const resource of normalized) {
    await sendBytes(channel, target, resource.bytes, { class: 'input', path: `${root}/${resource.name}` });
  }
  return { class: 'input', path: `${root}/${entry}` };
}

export async function createRepositoryExecution({
  stateDirectory,
  platform = process.platform,
  env = process.env,
  invoke = invokeCommand,
  routes = null,
  rootFor,
  listPaths,
  resolveSubject,
  resolveTool,
  protectedValues = [],
  createState = createEnvironmentFoundation,
  createPreparation = createEnvironmentBootstrap,
  createChannel = createEnvironmentBridge,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('repository execution stateDirectory is required');
  if (typeof rootFor !== 'function' || typeof listPaths !== 'function' || typeof resolveSubject !== 'function' || typeof resolveTool !== 'function') {
    throw new TypeError('repository execution composition contracts are incomplete');
  }
  if (!Array.isArray(protectedValues) || protectedValues.some((value) => typeof value !== 'string')) throw new TypeError('repository execution protectedValues must be strings');
  const protectedEnvironmentValues = protectedValues.filter((value) => value.length >= 8);
  const policy = routes == null ? await loadEnvironmentExecutionRoutes(stateDirectory) : normalizeEnvironmentExecutionRoutes(routes);
  if (!policy || policy.routes.length === 0) return new UnavailableRepositoryExecution({ reason: 'no local persistent-environment execution routes are configured' });
  if (!['win32', 'linux'].includes(platform)) return new UnavailableRepositoryExecution({ reason: 'no persistent-environment execution attachment is available for this host platform' });

  const state = await createState({ stateDirectory, platform, invoke });
  const observed = await state.inspect();
  if (observed?.ready !== true) return new UnavailableRepositoryExecution({ reason: observed?.reason ?? 'environment foundation is not ready' });
  const known = await state.listEnvironments();
  const routed = known.filter((entry) => policy.routes.some((route) => route.subject === entry.record?.subject && route.profile === entry.record?.profile) && entry.observation?.exists && entry.observation?.owned && entry.observation?.compatible);
  if (routed.length === 0) return new UnavailableRepositoryExecution({ reason: 'no routed persistent environment is present and compatible' });

  const access = async (target) => {
    const current = await state.observeEnvironment(target);
    const route = policy.routes.find((entry) => entry.subject === current.record.subject && entry.profile === current.record.profile);
    if (!route) throw new Error('environment target is no longer admitted by local execution routes');
    return resolvedAccess(route, platform, env);
  };
  const preparation = await createPreparation({ stateDirectory, platform, invoke, access });
  const channel = await createChannel({ stateDirectory, platform, invoke, access: (target) => preparation.connection(target) });
  const status = {
    protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
    state: 'ready', ready: true,
    identity: hashIdentity({ foundation: observed.identity, routes: policy.routes.map((route) => [route.subject, route.profile]) }).slice(0, 128),
    reason: null,
  };
  const agentBytes = await readFile(AGENT_FILE);
  const resourceAgentBytes = await readFile(RESOURCE_AGENT_FILE);
  const stagingRoot = path.join(path.resolve(stateDirectory), 'repository-execution', 'staging');
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });

  return new RepositoryEnvironmentExecution({
    status,
    open: async (scope) => {
      const subject = stableSubject(await resolveSubject(structuredClone(scope)), 'repository execution subject');
      const route = routeForSubject(policy, subject);
      const matches = (await state.listEnvironments()).filter((entry) => entry.record?.subject === subject && entry.record?.profile === route.profile);
      if (matches.length !== 1) throw new Error(matches.length === 0 ? 'routed persistent environment is absent' : 'routed persistent environment is ambiguous');
      const selected = matches[0];
      if (!selected.observation?.exists || !selected.observation?.owned || !selected.observation?.compatible) throw new Error(selected.observation?.reason ?? 'routed persistent environment is unavailable');
      const target = selected.record.identity;
      const root = await realpath(path.resolve(await rootFor(structuredClone(scope))));
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('repository source root must be a real directory');
      const releaseSession = await acquireExclusiveSession(path.join(path.resolve(stateDirectory), 'repository-execution', 'locks'), target);
      let source = null;
      let evidenceIdentity = null;
      const agentLocation = { class: 'input', path: 'control/workspace-agent.mjs' };
      const resourceAgentLocation = { class: 'input', path: 'control/resource-agent.mjs' };
      const stateLocation = { class: 'cache', path: 'source-state.json' };
      const sourceManifestLocation = { class: 'input', path: 'source/manifest.json' };
      const candidateDirectory = { class: 'output', path: 'candidate' };
      const scratchRoot = `subjects/${subject}/runs/${scope.runId}`;
      const scratchRunLocation = { class: 'scratch', path: scratchRoot };

      const runAgent = async (action, argumentsList, { directory = '.', timeoutMs = 120_000, maxOutputBytes = 256 * 1024, signal = null, onActivity = null } = {}) => {
        const outcome = await channel.execute(target, {
          program: 'node',
          arguments: [agentLocation, action, ...argumentsList],
          directory: { class: 'work', path: directory },
          environment: {}, input: null, timeoutMs, maxOutputBytes,
        }, { signal, onActivity, pollIntervalMs: 500 });
        return { outcome, parsed: parseAgentResult(outcome, `workspace ${action}`) };
      };

      const snapshot = async () => snapshotFileTree({
        root,
        listPaths: async (canonicalRoot) => listPaths(canonicalRoot, structuredClone(scope)),
        acceptPath: repositoryPathAllowed,
      });

      return {
        async prepare({ signal = null, onActivity = null } = {}) {
          ensureActive(signal);
          const ready = await preparation.ensure(target);
          ensureActive(signal);
          const health = await channel.health(target);
          if (!health.ready) throw new Error(health.reason ?? 'environment exchange is not ready');
          source = await snapshot();
          ensureActive(signal);
          await sendBytes(channel, target, agentBytes, agentLocation);
          const prepared = await runAgent('prepare', [stateLocation, source.manifest.digest], { timeoutMs: 60_000, signal, onActivity });
          if (prepared.parsed.appliedDigest !== source.manifest.digest) {
            for (const entry of source.manifest.entries) {
              if (entry.type !== 'file') continue;
              for (const part of entry.parts) {
                ensureActive(signal);
                const destination = { class: 'input', path: `source/${part.name}` };
                await channel.put(target, { read: (request) => source.readPart(part.name, request) }, destination, { maxBytes: Math.max(1, part.size) });
              }
            }
            await sendBytes(channel, target, source.manifestBytes(), sourceManifestLocation);
            const applied = await runAgent('apply', [sourceManifestLocation, stateLocation], { timeoutMs: 10 * 60_000, signal, onActivity });
            if (applied.parsed.digest !== source.manifest.digest) throw new Error('guest source synchronization did not bind the expected digest');
          }
          const current = await snapshot();
          if (current.manifest.digest !== source.manifest.digest) throw new Error('authoritative source changed during guest synchronization');
          evidenceIdentity = hashIdentity({ target, bootstrap: ready.generation, bridge: health.version, source: source.manifest.digest }).slice(0, 128);
          return { identity: evidenceIdentity };
        },

        async input(name, port, { signal = null } = {}) {
          ensureActive(signal);
          await channel.put(target, executionInput(port), { class: 'input', path: `ports/${name}` }, { maxBytes: TRANSFER_LIMIT });
          ensureActive(signal);
        },

        async run({ invocation, environment, transfers = [], limits, stdin, signal = null, onActivity = null }) {
          if (!source || !evidenceIdentity) throw new Error('repository execution session was not prepared');
          const resolved = await resolveTool(invocation.tool, { subject, profile: route.profile, scope: structuredClone(scope) });
          const entryLocation = await stageToolResources(channel, target, resolved);
          const materialized = descriptorFor(invocation, resolved, environment, stdin, transfers, protectedEnvironmentValues, entryLocation, scratchRoot);
          const descriptorBytes = Buffer.from(`${JSON.stringify(materialized.descriptor)}\n`, 'utf8');
          if (descriptorBytes.length > 8 * 1024 * 1024) throw new Error('repository operation descriptor exceeds the bounded staging limit');
          const descriptorDigest = createHash('sha256').update(descriptorBytes).digest('hex').slice(0, 32);
          const descriptorLocation = { class: 'input', path: `control/operation-${descriptorDigest}.json` };
          await sendBytes(channel, target, descriptorBytes, descriptorLocation);
          return channel.execute(target, {
            program: 'node',
            arguments: [agentLocation, 'run', descriptorLocation, ...materialized.locations],
            directory: { class: 'work', path: invocation.workingDirectory },
            environment: {}, input: null,
            timeoutMs: limits.timeoutMs,
            maxOutputBytes: Math.min(limits.maxOutputBytes, BRIDGE_OUTPUT_LIMIT),
          }, { signal, onActivity });
        },

        async output(name, port, { signal = null } = {}) {
          ensureActive(signal);
          await channel.get(target, { class: 'output', path: `ports/${name}` }, executionOutput(port), { maxBytes: TRANSFER_LIMIT });
          ensureActive(signal);
        },

        async collect({ identity, operation = null, signal = null } = {}) {
          ensureActive(signal);
          if (identity !== evidenceIdentity || !source) throw new Error('repository execution evidence identity changed before candidate collection');
          const before = await snapshot();
          if (before.manifest.digest !== source.manifest.digest) throw new Error('authoritative source changed during repository execution; guest result is stale');
          if (typeof operation === 'string' && (operation.startsWith('tool.probe:') || operation.startsWith('runtime.validate:'))) return;
          await runAgent('collect', [candidateDirectory, stateLocation], { timeoutMs: 5 * 60_000, signal });
          const manifestBytes = await receiveBytes(channel, target, { class: 'output', path: 'candidate/manifest.json' }, MANIFEST_LIMIT);
          let raw;
          try { raw = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('guest candidate manifest is invalid JSON'); }
          const manifest = normalizeFileTreeDelta(raw, { root, acceptPath: repositoryPathAllowed });
          if (manifest.basisDigest !== source.manifest.digest) throw new Error('guest candidate is based on stale source identity');
          const stage = path.join(stagingRoot, scope.runId, randomUUID());
          try {
            const staged = await stageFileTreeDelta({
              manifest, root, stagingRoot: stage, acceptPath: repositoryPathAllowed,
              readPart: async (name) => { ensureActive(signal); return receiveBytes(channel, target, { class: 'output', path: `candidate/${name}` }, FILE_TREE_PART_BYTES); },
            });
            ensureActive(signal);
            const current = await snapshot();
            if (current.manifest.digest !== source.manifest.digest) throw new Error('authoritative source drifted before candidate import');
            ensureActive(signal);
            await applyStagedFileTreeDelta({ root, stagingRoot: stage, manifest: staged, acceptPath: repositoryPathAllowed, signal });
          } finally { await rm(stage, { recursive: true, force: true }); }
        },

        async cleanup({ resource, signal = null } = {}) {
          ensureActive(signal);
          if (resource !== 'scratch') throw new Error('repository execution cleanup resource is unsupported');
          await preparation.ensure(target);
          ensureActive(signal);
          const health = await channel.health(target);
          if (!health.ready) throw new Error(health.reason ?? 'environment exchange is not ready');
          await sendBytes(channel, target, resourceAgentBytes, resourceAgentLocation);
          const outcome = await channel.execute(target, {
            program: 'node',
            arguments: [resourceAgentLocation, 'remove-directory', scratchRunLocation],
            directory: { class: 'work', path: '.' },
            environment: {}, input: null, timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
          }, { signal, pollIntervalMs: 500 });
          const parsed = parseAgentResult(outcome, 'resource cleanup');
          if (parsed.state !== 'verified-absent' || typeof parsed.removed !== 'boolean') throw new Error('resource cleanup did not verify absence');
          return {
            state: parsed.state,
            removed: parsed.removed,
            identity: hashIdentity({ target, subject, runId: scope.runId, resource }).slice(0, 128),
          };
        },
        close: releaseSession,
      };
    },
  });
}

export function gitVisiblePathsFromResult(result) {
  return splitNul(result?.stdout ?? '');
}