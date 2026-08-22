import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createExecutionProfileRouting,
  createWorkspaceScopedChannel,
  executionWorkspaceIdentity,
} from './execution-profile-routing.js';
import {
  ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
  loadEnvironmentExecutionRoutes,
  normalizeEnvironmentExecutionRoutes,
  repositoryExecutionRoutesPath,
} from './repository-execution.js';

const STABLE_SUBJECT = /^\d+$/u;
const READY_BYTES = Buffer.from('ready\n', 'utf8');

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function sameAccess(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertChannel(value) {
  if (!value || ['health', 'execute', 'put', 'get'].some((name) => typeof value[name] !== 'function')) throw new TypeError('environment workspace channel contract is incomplete');
  return value;
}

function sourceFor(bytes) {
  const value = Buffer.from(bytes);
  return Object.freeze({
    async read({ offset, limit }) {
      const end = Math.min(value.length, offset + limit);
      return Object.freeze({ data: value.subarray(offset, end), eof: end === value.length });
    },
  });
}

function observed(outcome, name) {
  if (!outcome || outcome.completion !== 'observed') throw new Error(`${name} completion is not observed`);
  const result = outcome.result;
  if (!result || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || `${name} failed`).trim().slice(0, 2048));
  }
}

async function atomicPolicy(stateDirectory, policy) {
  const file = repositoryExecutionRoutesPath(stateDirectory);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('environment route directory must be a real directory');
  try {
    const current = await lstat(file);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('environment route file must be a real file');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.execution-routes-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(policy)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

function normalizedAccess(profile, raw) {
  const policy = normalizeEnvironmentExecutionRoutes({
    protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
    routes: [{ subject: '1', profile, preferred: false, validation: false, access: raw }],
  });
  return policy.routes[0].access;
}

export function createEnvironmentConstructionWorkspaces({
  stateDirectory,
  state,
  channel = null,
  resolveChannel = null,
  resolveAuthority,
  resolveAccess,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment workspace stateDirectory is required');
  if (!state || typeof state.listEnvironments !== 'function' || typeof state.observeEnvironment !== 'function' || typeof state.inspect !== 'function') throw new TypeError('environment workspace state contract is incomplete');
  if (channel == null && typeof resolveChannel !== 'function') throw new TypeError('environment workspace channel contract is incomplete');
  if (channel != null) assertChannel(channel);
  if (resolveChannel != null && typeof resolveChannel !== 'function') throw new TypeError('environment workspace channel resolver is invalid');
  if (typeof resolveAuthority !== 'function' || typeof resolveAccess !== 'function') throw new TypeError('environment workspace authority contract is incomplete');

  const resolve = async (rawRequest, { publish = false } = {}) => {
    const request = requireObject(rawRequest, 'environment workspace request');
    const declaration = requireObject(request.declaration, 'environment workspace declaration');
    const workspaces = request.workspaces ?? declaration.workspaces;
    if (!Array.isArray(workspaces) || JSON.stringify(workspaces) !== JSON.stringify(declaration.workspaces)) throw new Error('environment workspaces no longer match declaration authority');
    const access = normalizedAccess(declaration.profile, await resolveAccess(Object.freeze({ declaration })));
    const selected = [];
    for (const workspace of workspaces) {
      const subject = String(await resolveAuthority(workspace.authority));
      if (!STABLE_SUBJECT.test(subject)) throw new Error('environment workspace authority did not resolve to a stable subject');
      if (executionWorkspaceIdentity(subject, declaration.profile) !== workspace.identity) throw new Error('environment workspace identity does not match host authority');
      selected.push(Object.freeze({ subject, workspace }));
    }

    const existing = await loadEnvironmentExecutionRoutes(stateDirectory);
    const routes = existing ? existing.routes.map((route) => structuredClone(route)) : [];
    let changed = false;
    for (const entry of selected) {
      const matches = routes.filter((route) => route.subject === entry.subject && route.profile === declaration.profile);
      if (matches.length > 1) throw new Error('environment workspace route is ambiguous');
      if (matches.length === 1) {
        if (!sameAccess(matches[0].access, access)) throw new Error('environment workspace route access changed; setup re-entry is required');
        continue;
      }
      routes.push({ subject: entry.subject, profile: declaration.profile, preferred: false, validation: false, access: structuredClone(access) });
      changed = true;
    }
    const policy = normalizeEnvironmentExecutionRoutes({ protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL, routes });
    if (publish && changed) await atomicPolicy(stateDirectory, policy);
    const selectedChannel = assertChannel(channel ?? await resolveChannel(Object.freeze({ declaration })));
    const routing = createExecutionProfileRouting({ state, policy });
    const scoped = createWorkspaceScopedChannel({ channel: selectedChannel, routing });
    return { request, declaration, selected, policy, routing, scoped, changed };
  };

  const verifyRoots = async (resolved) => {
    for (const entry of resolved.selected) {
      const target = resolved.routing.targetForSubject(entry.subject);
      const health = await resolved.scoped.health(target);
      if (health?.ready !== true) throw new Error(health?.reason ?? 'environment workspace exchange is unavailable');
      await resolved.scoped.put(target, sourceFor(READY_BYTES), { class: 'input', path: 'lifecycle/ready' }, { maxBytes: READY_BYTES.length });
      const outcome = await resolved.scoped.execute(target, {
        program: 'node',
        arguments: [
          '-e',
          'process.stdout.write("ready")',
          { class: 'output', path: 'lifecycle/ready' },
          { class: 'scratch', path: 'lifecycle/ready' },
          { class: 'cache', path: 'lifecycle/ready' },
        ],
        directory: { class: 'work', path: '.' },
        environment: {},
        input: null,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      }, { pollIntervalMs: 500 });
      observed(outcome, 'environment workspace preparation');
    }
    return Object.freeze({ ready: true, count: resolved.selected.length });
  };

  return Object.freeze({
    async ensure(request) {
      const resolved = await resolve(request, { publish: true });
      await verifyRoots(resolved);
      return Object.freeze({ ready: true, implementationGeneration: request.implementationGeneration, routesChanged: resolved.changed, workspaceCount: resolved.selected.length });
    },
    async inspect(request) {
      try {
        const resolved = await resolve(request, { publish: false });
        const status = await verifyRoots(resolved);
        return Object.freeze({ ...status, routeCount: resolved.policy.routes.length });
      } catch (error) {
        return Object.freeze({ ready: false, reason: String(error?.message ?? error).slice(0, 2048) });
      }
    },
  });
}
