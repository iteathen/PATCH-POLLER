import { spawn } from 'node:child_process';
import { PolicyError } from '../errors.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  assertRepositoryExecutionContract,
  normalizeRepositoryExecutionCleanupResult,
  normalizeRepositoryExecutionResult,
} from './repository-execution.js';
import { applyChildProcessPriority } from './process-priority.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const DEFAULT_OUTPUT_LIMIT = 512 * 1024;
const DEFAULT_ACTIVITY_INTERVAL_MS = 30_000;
const FAULT_TRUNCATE_BYTES = 32;
const EXECUTION_CLASSES = new Set(['control-process', 'static-inspection', 'repository-code']);

function appendTail(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
}

function boundedEnvironment(source, pass = [], set = {}) {
  const env = {};
  for (const name of pass) if (source[name] != null) env[name] = source[name];
  Object.assign(env, set);
  env.GIT_TERMINAL_PROMPT = '0';
  env.DEVBRIDGE_NONINTERACTIVE = '1';
  env.NO_COLOR ??= '1';
  return env;
}

function truncateFault(buffer) {
  return buffer.length <= FAULT_TRUNCATE_BYTES ? buffer : buffer.subarray(buffer.length - FAULT_TRUNCATE_BYTES);
}

function abortedError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new PolicyError('deterministic operation aborted by the control plane');
}

function assertRepositoryScope(repository, runId) {
  if (typeof repository !== 'string' || repository.length === 0) throw new PolicyError('repository-code execution requires repository identity');
  if (typeof runId !== 'string' || runId.length === 0) throw new PolicyError('repository-code execution requires run identity');
}

export class DeterministicProcessRunner {
  #sourceEnv;
  #faults;
  #repositoryExecution;
  #processPriority;
  #setPriority;

  constructor({
    sourceEnv = process.env,
    faultInjector = null,
    repositoryExecution = null,
    processPriority = 'below-normal',
    setPriority = undefined,
  } = {}) {
    this.#sourceEnv = sourceEnv;
    this.#faults = faultInjector;
    this.#repositoryExecution = repositoryExecution == null ? null : assertRepositoryExecutionContract(repositoryExecution);
    this.#processPriority = processPriority;
    this.#setPriority = setPriority;
  }

  async cleanup({
    executionClass = 'repository-code',
    repository = null,
    repositoryId = null,
    runId = null,
    resource = 'scratch',
    signal = null,
  } = {}) {
    if (signal?.aborted) throw abortedError(signal);
    if (executionClass !== 'repository-code') throw new PolicyError('deterministic cleanup is only available for repository-code execution');
    if (!this.#repositoryExecution) throw new PolicyError('repository-code cleanup is unavailable because no repository execution implementation is configured');
    const status = this.#repositoryExecution.inspect();
    if (status.ready !== true) throw new PolicyError(`repository-code cleanup is unavailable: ${status.reason ?? 'repository execution is not ready'}`);
    assertRepositoryScope(repository, runId);
    if (typeof this.#repositoryExecution.cleanup !== 'function') throw new PolicyError('repository-code cleanup is unavailable because the execution boundary does not provide cleanup');
    return normalizeRepositoryExecutionCleanupResult(await this.#repositoryExecution.cleanup({
      scope: { repository, repositoryId, runId },
      resource,
      signal,
    }));
  }

  async run({
    executable,
    args = [],
    cwd,
    timeoutMs = 120_000,
    maxOutputBytes = DEFAULT_OUTPUT_LIMIT,
    environment = { pass: [], set: {} },
    stdin = null,
    onActivity = null,
    activityIntervalMs = DEFAULT_ACTIVITY_INTERVAL_MS,
    operation = null,
    executionClass = 'control-process',
    repository = null,
    repositoryId = null,
    runId = null,
    repositoryTool = null,
    repositoryWorkingDirectory = '.',
    signal = null,
  }) {
    if (signal?.aborted) throw abortedError(signal);
    if (!Array.isArray(args)) throw new PolicyError('deterministic operation args must be an array');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 28_800_000) throw new PolicyError('deterministic operation timeout is out of range');
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16_777_216) throw new PolicyError('deterministic operation output limit is out of range');
    if (!Number.isInteger(activityIntervalMs) || activityIntervalMs < 10 || activityIntervalMs > 300_000) throw new PolicyError('deterministic activity interval is out of range');
    if (!EXECUTION_CLASSES.has(executionClass)) throw new PolicyError('deterministic operation execution class is invalid');

    if (executionClass === 'repository-code') {
      if (!this.#repositoryExecution) throw new PolicyError('repository-code execution is unavailable because no repository execution implementation is configured');
      const status = this.#repositoryExecution.inspect();
      if (status.ready !== true) throw new PolicyError(`repository-code execution is unavailable: ${status.reason ?? 'repository execution is not ready'}`);
      assertRepositoryScope(repository, runId);
      if (typeof repositoryTool !== 'string' || repositoryTool.length === 0) throw new PolicyError('repository-code execution requires a logical repository tool identity');
      const result = normalizeRepositoryExecutionResult(await this.#repositoryExecution.execute({
        protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
        operation: operation ?? 'repository.operation',
        scope: { repository, repositoryId, runId },
        invocation: {
          tool: repositoryTool,
          arguments: args,
          workingDirectory: repositoryWorkingDirectory,
        },
        environment: { ...(environment.set ?? {}) },
        transfers: [],
        limits: { timeoutMs, maxOutputBytes },
        stdin,
        signal,
        onActivity,
      }));
      return {
        ...result,
        execution: {
          class: executionClass,
          location: 'repository',
          identity: result.evidence.identity,
          scope: result.evidence.scope,
        },
        processPriority: null,
      };
    }

    if (args.some((value) => typeof value !== 'string')) throw new PolicyError('deterministic host operation args must be strings');
    if (typeof executable !== 'string' || executable.length === 0) throw new PolicyError('deterministic host operation executable is missing');

    const env = boundedEnvironment(this.#sourceEnv, environment.pass ?? [], environment.set ?? {});
    const child = spawn(executable, args, containedSpawnOptions({ cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    let processPriority;
    try {
      processPriority = await applyChildProcessPriority(child, this.#processPriority, { setPriority: this.#setPriority });
    } catch (error) {
      await terminateProcessTree(child);
      throw error;
    }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const deadlineAt = new Date(startedAtMs + timeoutMs).toISOString();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let lastOutputAt = null;
    let lastActivityEmitAt = 0;
    let activityError = null;
    let activityQueue = Promise.resolve();

    const emitActivity = (kind, { force = false, stream = null, bytes = null, processAlive = child.exitCode == null } = {}) => {
      if (typeof onActivity !== 'function') return;
      const atMs = Date.now();
      if (!force && lastActivityEmitAt !== 0 && atMs - lastActivityEmitAt < activityIntervalMs) return;
      lastActivityEmitAt = atMs;
      const at = new Date(atMs).toISOString();
      const payload = { kind, at, startedAt, elapsedMs: Math.max(0, atMs - startedAtMs), lastOutputAt, deadlineAt, timeoutMs, processAlive };
      if (stream) payload.stream = stream;
      if (bytes != null) payload.bytes = bytes;
      activityQueue = activityQueue.then(async () => {
        if (activityError) return;
        try { await onActivity(payload); } catch (error) { activityError = error; }
      });
    };

    emitActivity('started', { force: true, processAlive: true });
    const heartbeat = typeof onActivity === 'function'
      ? setInterval(() => emitActivity('heartbeat', { force: true, processAlive: child.exitCode == null }), activityIntervalMs)
      : null;
    heartbeat?.unref?.();

    const observe = (stream, chunk) => {
      lastOutputAt = new Date().toISOString();
      emitActivity('output', { stream, bytes: Buffer.byteLength(chunk) });
    };
    child.stdout.on('data', (chunk) => {
      const next = appendTail(stdout, chunk, maxOutputBytes);
      stdout = next.buffer;
      outputTruncated ||= next.truncated;
      observe('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      const next = appendTail(stderr, chunk, maxOutputBytes);
      stderr = next.buffer;
      outputTruncated ||= next.truncated;
      observe('stderr', chunk);
    });
    if (stdin == null) child.stdin.end(); else child.stdin.end(String(stdin));

    let timedOut = false;
    let aborted = false;
    let termination = null;
    const terminate = () => { termination ??= terminateProcessTree(child); };
    const onAbort = () => { aborted = true; terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref?.();
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    }).finally(async () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (heartbeat) clearInterval(heartbeat);
      if (termination) await termination;
    });

    emitActivity('finished', { force: true, processAlive: false });
    await activityQueue;
    if (activityError) throw activityError;

    const fault = this.#faults?.throwIfTriggered('process.after-exit', { operation }) ?? null;
    if (fault?.action === 'timeout') timedOut = true;
    if (fault?.action === 'truncate-output') {
      stdout = truncateFault(stdout);
      stderr = truncateFault(stderr);
      outputTruncated = true;
    }

    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      aborted,
      outputTruncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      startedAt,
      finishedAt: new Date().toISOString(),
      lastOutputAt,
      execution: { class: executionClass, location: 'host', identity: 'host-control' },
      processPriority,
    };
  }
}