import path from 'node:path';
import { createExecutionProfileRepositoryExecution } from './execution-profile-routing.js';
import { gitVisiblePathsFromResult } from './repository-execution.js';
import { resolveBuiltInHelper } from './builtin-helper-resolver.js';

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/u;
const SAFE_RUN = /^[A-Za-z0-9_.-]{1,120}$/u;
const SAFE_PROGRAM = /^[A-Za-z][A-Za-z0-9_.+-]{0,159}$/u;
const DIRECT_TOOLS = new Set(['node', 'cmake', 'ctest', 'npm', 'npx']);

function programName(value) {
  const base = path.basename(String(value ?? '')).replace(/\.(?:cmd|bat|exe)$/iu, '');
  if (!SAFE_PROGRAM.test(base)) throw new Error('local tool profile cannot produce a safe guest program identity');
  return base;
}

export function scopeForExecutionDirectory(workspaceRoot, directory) {
  if (typeof workspaceRoot !== 'string' || typeof directory !== 'string') throw new TypeError('execution scope paths are required');
  const root = path.join(path.resolve(workspaceRoot), 'worktrees');
  const relative = path.relative(root, path.resolve(directory));
  if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('repository execution directory is outside the managed worktree root');
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length !== 3 || !SAFE_SEGMENT.test(parts[0]) || !SAFE_SEGMENT.test(parts[1]) || !SAFE_RUN.test(parts[2])) {
    throw new Error('repository execution directory does not identify one exact managed run');
  }
  return { repository: `${parts[0]}/${parts[1]}`, repositoryId: null, runId: parts[2] };
}

function scopedRunner(delegate, workspaceRoot) {
  if (!delegate || typeof delegate.run !== 'function') throw new TypeError('execution runner delegate is incomplete');
  const scopeRequest = (request) => {
    if (request?.executionClass !== 'repository-code' || (request.repository && request.runId)) return request;
    const scope = scopeForExecutionDirectory(workspaceRoot, request.cwd);
    return { ...request, ...scope };
  };
  return {
    run(request) { return delegate.run(scopeRequest(request)); },
    cleanup: typeof delegate.cleanup === 'function'
      ? (request) => delegate.cleanup(scopeRequest(request))
      : undefined,
  };
}

function repositoryEndpoint(repository) {
  const parts = String(repository).split('/');
  if (parts.length !== 2 || parts.some((part) => !SAFE_SEGMENT.test(part))) throw new Error('repository identity is invalid');
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export async function createRuntimeExecutionContext({
  config,
  workspaceManager,
  gitClient,
  client,
  toolProfiles = config?.tools ?? {},
  protectedValues = [],
  env = process.env,
} = {}) {
  if (!config || !workspaceManager || !gitClient || !client) throw new TypeError('runtime execution composition is incomplete');
  const repositoryIds = new Map();
  const repositoryExecution = await createExecutionProfileRepositoryExecution({
    stateDirectory: config.state.directory,
    env,
    protectedValues,
    rootFor: async (scope) => workspaceManager.worktreePath(scope.repository, scope.runId),
    listPaths: async (root) => gitVisiblePathsFromResult(await gitClient.run(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })),
    resolveSubject: async (scope) => {
      if (scope.repositoryId != null) return String(scope.repositoryId);
      if (repositoryIds.has(scope.repository)) return repositoryIds.get(scope.repository);
      const response = await client.request('GET', repositoryEndpoint(scope.repository));
      const observed = response?.data;
      if (!observed || !Number.isSafeInteger(Number(observed.id)) || Number(observed.id) < 1) throw new Error('repository stable identity could not be observed');
      if (typeof observed.full_name === 'string' && observed.full_name.toLowerCase() !== scope.repository.toLowerCase()) throw new Error('repository stable identity observation returned a different repository');
      const identity = String(observed.id);
      repositoryIds.set(scope.repository, identity);
      return identity;
    },
    resolveTool: async (tool) => {
      if (DIRECT_TOOLS.has(tool)) return { program: tool, arguments: [] };
      const builtIn = await resolveBuiltInHelper(tool);
      if (builtIn) return builtIn;
      const profile = toolProfiles?.[tool];
      if (profile?.executable) return { program: programName(profile.executable), arguments: [] };
      if (!SAFE_PROGRAM.test(tool)) throw new Error('logical tool identity cannot be used as a guest program');
      return { program: tool, arguments: [] };
    },
  });
  return Object.freeze({
    repositoryExecution,
    scope(delegate) { return scopedRunner(delegate, config.workspace.root); },
  });
}