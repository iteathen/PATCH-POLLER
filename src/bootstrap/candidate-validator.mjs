import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { GitClient } from '../git/git-client.js';
import {
  gitVisiblePathsFromResult,
  loadEnvironmentExecutionRoutes,
  validationEnvironmentExecutionRoute,
} from '../app/repository-execution.js';
import { createExecutionProfileRepositoryExecution } from '../app/execution-profile-routing.js';
import { createFastVmRepositoryExecution } from '../app/fast-vm-repository-execution.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  normalizeRepositoryExecutionResult,
} from '../runtime/repository-execution.js';
import { runtimeArtifactSha256 } from './release-integrity.mjs';

const CHECKS = Object.freeze([
  Object.freeze({ name: 'preflight', operation: 'runtime.validate:preflight', arguments: ['src/bootstrap/repository-preflight.mjs'], timeoutMs: 4 * 60_000 }),
  Object.freeze({ name: 'tests', operation: 'runtime.validate:tests', arguments: ['--test'], timeoutMs: 10 * 60_000 }),
]);

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }

function repositoryFromRemote(value) {
  const text = String(value ?? '').trim().replace(/\/$/u, '').replace(/\.git$/iu, '');
  const match = text.match(/(?:[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (!match) fail('candidate source remote does not identify one repository');
  return `${match[1]}/${match[2]}`;
}

function protectedValues(config, policy, env) {
  const names = new Set(config.github.auth.environmentVariables);
  for (const route of policy.routes) {
    if (route.access.passwordEnvironment) names.add(route.access.passwordEnvironment);
  }
  return [...names]
    .map((name) => env[name])
    .filter((value) => typeof value === 'string' && value.length >= 8);
}

export function candidateRepositoryExecutionFactory(config, {
  createExecution = createExecutionProfileRepositoryExecution,
  createFastVmExecution = createFastVmRepositoryExecution,
} = {}) {
  return config?.execution?.fastVmDefaultSwitch === true ? createFastVmExecution : createExecution;
}

async function createExecutionContext(paths, runtime, env) {
  const config = await loadConfig(paths.config ?? path.join(paths.home, 'config.json'));
  const policy = await loadEnvironmentExecutionRoutes(config.state.directory);
  const route = validationEnvironmentExecutionRoute(policy);
  const git = new GitClient({
    executable: config.git.executable,
    syntheticHome: paths.gitHome ?? path.join(paths.home, 'bootstrap-git-home'),
    defaultTimeoutMs: config.git.commandTimeoutMs,
  });
  const remote = await git.run(['remote', 'get-url', 'origin'], { cwd: runtime.runtimeDir });
  const scope = {
    repository: repositoryFromRemote(remote.stdout),
    repositoryId: route.subject,
    runId: `runtime-${String(runtime.head).slice(0, 16).toLowerCase()}`,
  };
  const createExecution = candidateRepositoryExecutionFactory(config);
  const execution = await createExecution({
    stateDirectory: config.state.directory,
    env,
    routes: policy,
    protectedValues: protectedValues(config, policy, env),
    rootFor: async () => path.resolve(runtime.runtimeDir),
    listPaths: async (root) => gitVisiblePathsFromResult(await git.run(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })),
    resolveSubject: async () => route.subject,
    resolveTool: async (name) => {
      if (name !== 'node') fail('candidate validation requested an unadmitted logical tool');
      return { program: 'node', arguments: [] };
    },
  });
  return { execution, scope };
}

async function runCheck(execution, scope, check) {
  const result = normalizeRepositoryExecutionResult(await execution.execute({
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: check.operation,
    scope,
    invocation: { tool: 'node', arguments: check.arguments, workingDirectory: '.' },
    environment: { CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', DEVBRIDGE_NONINTERACTIVE: '1' },
    transfers: [],
    limits: { timeoutMs: check.timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
    stdin: null,
    signal: null,
    onActivity: null,
  }));
  if (result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    const detail = String(result.stderr || result.stdout || `${check.name} failed`).trim().slice(-4_000);
    fail(`candidate ${check.name} failed${detail ? `: ${detail}` : ''}`);
  }
  return Object.freeze({
    state: 'passed',
    evidence: result.evidence,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  });
}

export async function validateRuntimeCandidate(paths, runtime, _legacyRunner = null, {
  expectedArtifactSha256 = null,
  env = process.env,
  executionContext = null,
  executionContextFactory = createExecutionContext,
} = {}) {
  const runtimeDir = path.resolve(runtime.runtimeDir);
  const before = await runtimeArtifactSha256(runtimeDir);
  if (expectedArtifactSha256 && before.sha256 !== expectedArtifactSha256) {
    fail(`candidate artifact changed before validation; expected ${expectedArtifactSha256}, observed ${before.sha256}`);
  }
  const context = executionContext ?? await executionContextFactory(paths, { ...runtime, runtimeDir }, env);
  if (!context?.execution || typeof context.execution.inspect !== 'function' || typeof context.execution.execute !== 'function') {
    fail('candidate validation execution context is incomplete');
  }
  const status = context.execution.inspect();
  if (status.ready !== true) fail(`candidate validation execution is unavailable: ${status.reason ?? 'execution boundary is not ready'}`);

  const checks = {};
  for (const check of CHECKS) checks[check.name] = await runCheck(context.execution, context.scope, check);

  const after = await runtimeArtifactSha256(runtimeDir);
  if (after.sha256 !== before.sha256) fail('candidate artifact changed during execution validation');
  return Object.freeze({
    artifactSha256: after.sha256,
    preflight: checks.preflight.state,
    tests: checks.tests.state,
    execution: Object.freeze({ state: 'passed', identity: status.identity, checks: Object.freeze(checks) }),
  });
}

export function candidateValidationAvailability() {
  return Object.freeze({ state: 'ready', ready: true, reason: null });
}
