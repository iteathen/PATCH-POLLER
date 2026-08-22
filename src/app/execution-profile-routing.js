import { createHash } from 'node:crypto';
import { createEnvironmentBootstrap } from './environment-bootstrap.js';
import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import {
  createRepositoryExecution,
  loadEnvironmentExecutionRoutes,
  normalizeEnvironmentExecutionRoutes,
} from './repository-execution.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const MAX_SUBJECT_BYTES = 512;
const WORKSPACE_CLASSES = Object.freeze(['input', 'work', 'output', 'scratch', 'cache']);
const TRANSIENT_WORKSPACE_CLASSES = Object.freeze(['input', 'output', 'scratch']);
const REMOVE_TREE_SCRIPT = String.raw`const fs=require('node:fs');const target=process.argv[1];let info=null;try{info=fs.lstatSync(target);}catch(error){if(error&&error.code==='ENOENT'){process.stdout.write(JSON.stringify({verifiedAbsent:true}));process.exit(0);}throw error;}if(info.isSymbolicLink())throw new Error('workspace lifecycle target must not be a symbolic link');fs.rmSync(target,{recursive:true,force:false});if(fs.existsSync(target))throw new Error('workspace lifecycle target is still present');process.stdout.write(JSON.stringify({verifiedAbsent:true}));`;

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function opaqueSubject(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SUBJECT_BYTES) {
    throw new TypeError('workspace subject must be a bounded opaque identity');
  }
  return value;
}

function digest(namespace, ...parts) {
  const hash = createHash('sha256').update(namespace, 'utf8');
  for (const part of parts) hash.update('\0', 'utf8').update(String(part), 'utf8');
  return hash.digest('hex');
}

export function executionProfileSubject(profile) {
  const normalized = safeId(profile, 'execution profile');
  return `profile-${digest('execution-profile-v1', normalized).slice(0, 32)}`;
}

export function executionWorkspaceIdentity(subject, profile) {
  return `workspace-${digest('execution-workspace-v1', opaqueSubject(subject), safeId(profile, 'execution profile')).slice(0, 32)}`;
}

export function executionWorkspaceTarget(subject, profile) {
  return `env-${digest('execution-workspace-target-v1', opaqueSubject(subject), safeId(profile, 'execution profile')).slice(0, 32)}`;
}

function profileAccessKey(route) {
  return JSON.stringify(route.access ?? {});
}

function validateProfileAccess(policy) {
  const seen = new Map();
  for (const route of policy.routes) {
    const current = profileAccessKey(route);
    const prior = seen.get(route.profile);
    if (prior != null && prior !== current) {
      throw new Error(`execution profile ${route.profile} has conflicting guest-access configuration`);
    }
    seen.set(route.profile, current);
  }
}

function routeIndex(policy) {
  const byTarget = new Map();
  const byProfile = new Map();
  const bySubject = new Map();
  for (const route of policy.routes) {
    const target = executionWorkspaceTarget(route.subject, route.profile);
    if (byTarget.has(target)) throw new Error('execution workspace target identity collided');
    byTarget.set(target, route);
    if (!byProfile.has(route.profile)) byProfile.set(route.profile, []);
    byProfile.get(route.profile).push({ route, target });
    if (!bySubject.has(route.subject)) bySubject.set(route.subject, []);
    bySubject.get(route.subject).push({ route, target });
  }
  return { byTarget, byProfile, bySubject };
}

function preferredSubjectRoute(index, subject) {
  const matches = index.bySubject.get(opaqueSubject(subject)) ?? [];
  if (matches.length === 0) throw new Error('no local workspace route exists for the repository subject');
  if (matches.length === 1) return matches[0];
  const preferred = matches.filter((entry) => entry.route.preferred);
  if (preferred.length !== 1) throw new Error('repository subject has multiple workspace profiles and no unique preferred route');
  return preferred[0];
}

function syntheticEntry(route, target, physical) {
  return Object.freeze({
    record: Object.freeze({
      ...structuredClone(physical.record),
      identity: target,
      subject: route.subject,
      profile: route.profile,
    }),
    observation: Object.freeze({
      ...structuredClone(physical.observation),
      identity: target,
    }),
  });
}

function profileMatches(environments, profile) {
  const subject = executionProfileSubject(profile);
  return environments.filter((entry) => entry.record?.subject === subject && entry.record?.profile === profile);
}

export function createExecutionProfileRouting({ state, policy }) {
  if (!state || typeof state.inspect !== 'function' || typeof state.listEnvironments !== 'function' || typeof state.observeEnvironment !== 'function') {
    throw new TypeError('execution-profile state contract is incomplete');
  }
  const normalized = normalizeEnvironmentExecutionRoutes(policy);
  validateProfileAccess(normalized);
  const index = routeIndex(normalized);

  const physicalForRoute = async (route) => {
    const matches = profileMatches(await state.listEnvironments(), route.profile);
    if (matches.length > 1) throw new Error(`execution profile ${route.profile} has multiple persistent environments`);
    return matches[0] ?? null;
  };

  const routeForTarget = (target) => {
    const route = index.byTarget.get(target);
    if (!route) throw new Error('execution workspace target is not admitted by local profile routing');
    return route;
  };

  const physicalTarget = async (target) => {
    const route = routeForTarget(target);
    const physical = await physicalForRoute(route);
    if (!physical) throw new Error(`execution profile ${route.profile} has no persistent environment`);
    return physical.record.identity;
  };

  const representativeTarget = async (rawPhysicalTarget) => {
    const observed = await state.observeEnvironment(rawPhysicalTarget);
    const profile = observed?.record?.profile;
    const expectedSubject = profile ? executionProfileSubject(profile) : null;
    if (!profile || observed?.record?.subject !== expectedSubject) throw new Error('persistent environment is not owned by an execution profile');
    const routes = index.byProfile.get(profile) ?? [];
    if (routes.length < 1) throw new Error(`execution profile ${profile} has no admitted workspace routes`);
    return routes[0].target;
  };

  return Object.freeze({
    inspect: () => state.inspect(),
    async listEnvironments() {
      const physical = await state.listEnvironments();
      const result = [];
      for (const [target, route] of index.byTarget) {
        const matches = profileMatches(physical, route.profile);
        if (matches.length > 1) throw new Error(`execution profile ${route.profile} has multiple persistent environments`);
        if (matches.length === 1) result.push(syntheticEntry(route, target, matches[0]));
      }
      return result;
    },
    async observeEnvironment(target) {
      const route = routeForTarget(target);
      const physical = await physicalForRoute(route);
      if (!physical) throw new Error(`execution profile ${route.profile} has no persistent environment`);
      const observed = await state.observeEnvironment(physical.record.identity);
      return syntheticEntry(route, target, observed);
    },
    physicalTarget,
    representativeTarget,
    targetForSubject(subject) {
      return preferredSubjectRoute(index, subject).target;
    },
    workspaceIdentity(target) {
      const route = routeForTarget(target);
      return executionWorkspaceIdentity(route.subject, route.profile);
    },
    profileForTarget(target) {
      return routeForTarget(target).profile;
    },
  });
}

function scopedLocation(location, workspace) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) return location;
  const value = String(location.path ?? '.');
  return {
    ...location,
    path: value === '.' ? `workspaces/${workspace}` : `workspaces/${workspace}/${value}`,
  };
}

function scopedOperation(operation, workspace) {
  return {
    ...operation,
    directory: scopedLocation(operation.directory, workspace),
    arguments: (operation.arguments ?? []).map((entry) => typeof entry === 'string' ? entry : scopedLocation(entry, workspace)),
  };
}

function parseLifecycleResult(outcome, action) {
  if (!outcome || outcome.completion !== 'observed') throw new Error(`${action} completion is not observed`);
  const result = outcome.result;
  if (!result || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || `${action} failed`).trim().slice(0, 2048));
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`${action} returned invalid structured output`); }
  if (parsed?.verifiedAbsent !== true) throw new Error(`${action} did not verify the target absent`);
}

export function createWorkspaceScopedChannel({ channel, routing }) {
  if (!channel || typeof channel.health !== 'function' || typeof channel.execute !== 'function' || typeof channel.put !== 'function' || typeof channel.get !== 'function') {
    throw new TypeError('workspace channel contract is incomplete');
  }
  if (!routing || typeof routing.physicalTarget !== 'function' || typeof routing.workspaceIdentity !== 'function') {
    throw new TypeError('workspace routing contract is incomplete');
  }
  const resolve = async (target) => ({
    physical: await routing.physicalTarget(target),
    workspace: routing.workspaceIdentity(target),
  });
  const removeClasses = async (target, classes, { signal = null } = {}) => {
    const selected = await resolve(target);
    for (const className of classes) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('workspace lifecycle was aborted');
      const outcome = await channel.execute(selected.physical, {
        program: 'node',
        arguments: ['-e', REMOVE_TREE_SCRIPT, { class: className, path: `workspaces/${selected.workspace}` }],
        directory: { class: 'work', path: '.' },
        environment: {},
        input: null,
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 256 * 1024,
      }, { signal, pollIntervalMs: 500 });
      parseLifecycleResult(outcome, `workspace ${className} cleanup`);
    }
    return Object.freeze({ verifiedAbsent: true, workspace: selected.workspace, classes: Object.freeze([...classes]) });
  };
  return Object.freeze({
    async health(target) {
      const selected = await resolve(target);
      return channel.health(selected.physical);
    },
    async execute(target, operation, options) {
      const selected = await resolve(target);
      return channel.execute(selected.physical, scopedOperation(operation, selected.workspace), options);
    },
    async put(target, source, destination, options) {
      const selected = await resolve(target);
      return channel.put(selected.physical, source, scopedLocation(destination, selected.workspace), options);
    },
    async get(target, source, sink, options) {
      const selected = await resolve(target);
      return channel.get(selected.physical, scopedLocation(source, selected.workspace), sink, options);
    },
    cleanupWorkspace(target, options) {
      return removeClasses(target, TRANSIENT_WORKSPACE_CLASSES, options);
    },
    resetWorkspace(target, options) {
      return removeClasses(target, WORKSPACE_CLASSES, options);
    },
    async reseedWorkspace(target, options) {
      const result = await removeClasses(target, WORKSPACE_CLASSES, options);
      return Object.freeze({ ...result, requiresPrepare: true });
    },
  });
}

function createMappedPreparation(preparation, routing) {
  const map = (target) => routing.physicalTarget(target);
  return Object.freeze({
    inspect: typeof preparation.inspect === 'function' ? async (target) => preparation.inspect(await map(target)) : undefined,
    ensure: async (target) => preparation.ensure(await map(target)),
    verifyContinuity: typeof preparation.verifyContinuity === 'function'
      ? async (target) => preparation.verifyContinuity(await map(target))
      : undefined,
    connection: typeof preparation.connection === 'function'
      ? async (target) => preparation.connection(await map(target))
      : undefined,
    reconcile: typeof preparation.reconcile === 'function' ? (...args) => preparation.reconcile(...args) : undefined,
  });
}

function lifecycleScopeTarget(routing, resolveSubject, scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('workspace lifecycle scope is invalid');
  if (typeof resolveSubject !== 'function') throw new TypeError('workspace lifecycle subject resolver is unavailable');
  return Promise.resolve(resolveSubject(structuredClone(scope))).then((subject) => routing.targetForSubject(String(subject)));
}

export async function createExecutionProfileRepositoryExecution({
  stateDirectory,
  routes = null,
  createState = createEnvironmentFoundation,
  createPreparation = createEnvironmentBootstrap,
  createChannel = createEnvironmentBridge,
  ...options
} = {}) {
  const policy = routes == null ? await loadEnvironmentExecutionRoutes(stateDirectory) : normalizeEnvironmentExecutionRoutes(routes);
  let routing = null;
  let workspaceChannel = null;

  const routedStateFactory = async (input) => {
    const state = await createState(input);
    if (!policy) return state;
    routing = createExecutionProfileRouting({ state, policy });
    return routing;
  };

  const routedPreparationFactory = async (input) => {
    if (!routing) throw new Error('execution-profile routing state was not initialized');
    const preparation = await createPreparation({
      ...input,
      access: async (physical) => input.access(await routing.representativeTarget(physical)),
    });
    return createMappedPreparation(preparation, routing);
  };

  const routedChannelFactory = async (input) => {
    if (!routing) throw new Error('execution-profile routing state was not initialized');
    const channel = await createChannel({
      ...input,
      access: async (physical) => input.access(await routing.representativeTarget(physical)),
    });
    workspaceChannel = createWorkspaceScopedChannel({ channel, routing });
    return workspaceChannel;
  };

  const execution = await createRepositoryExecution({
    stateDirectory,
    routes: policy,
    ...options,
    createState: routedStateFactory,
    createPreparation: routedPreparationFactory,
    createChannel: routedChannelFactory,
  });
  if (!policy || !routing || !workspaceChannel) return execution;

  const resolveTarget = (scope) => lifecycleScopeTarget(routing, options.resolveSubject, scope);
  Object.defineProperties(execution, {
    cleanupWorkspace: {
      enumerable: false,
      value: async ({ scope, signal = null }) => workspaceChannel.cleanupWorkspace(await resolveTarget(scope), { signal }),
    },
    resetWorkspace: {
      enumerable: false,
      value: async ({ scope, signal = null }) => workspaceChannel.resetWorkspace(await resolveTarget(scope), { signal }),
    },
    reseedWorkspace: {
      enumerable: false,
      value: async ({ scope, signal = null }) => workspaceChannel.reseedWorkspace(await resolveTarget(scope), { signal }),
    },
  });
  return execution;
}
