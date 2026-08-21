import { createHash } from 'node:crypto';
import { PolicyError } from '../errors.js';
import {
  REPOSITORY_EXECUTION_CLEANUP_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  normalizeRepositoryExecutionCleanupRequest,
  normalizeRepositoryExecutionCleanupResult,
  normalizeRepositoryExecutionRequest,
  normalizeRepositoryExecutionResult,
  normalizeRepositoryExecutionStatus,
} from './repository-execution.js';

const REQUIRED_SESSION_METHODS = Object.freeze(['prepare', 'input', 'run', 'output', 'collect']);

function assertSession(value) {
  if (!value || typeof value !== 'object' || REQUIRED_SESSION_METHODS.some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('repository execution session contract is incomplete');
  }
  return value;
}

function observedOutcome(raw) {
  if (!raw || typeof raw !== 'object') throw new PolicyError('repository execution returned an invalid completion');
  if (raw.completion !== 'observed') {
    throw new PolicyError(`repository execution completion is ${raw.completion ?? 'invalid'}; refusing to infer success`);
  }
  if (!raw.result || typeof raw.result !== 'object') throw new PolicyError('repository execution did not return an observed result');
  return raw.result;
}

function preparedIdentity(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.identity !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(raw.identity)) {
    throw new PolicyError('repository execution preparation did not return a bounded evidence identity');
  }
  return raw.identity;
}

function cleanupEvidence(raw) {
  if (!raw || typeof raw !== 'object' || raw.state !== 'verified-absent' || typeof raw.removed !== 'boolean') {
    throw new PolicyError('repository execution cleanup did not verify the owned resource absent');
  }
  if (typeof raw.identity !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(raw.identity)) {
    throw new PolicyError('repository execution cleanup did not return a bounded evidence identity');
  }
  return { identity: raw.identity, state: raw.state, removed: raw.removed };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new PolicyError('repository execution aborted by the control plane');
}

function ensureActive(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function evidenceIdentity(identity, request) {
  const input = {
    identity,
    operation: request.operation,
    scope: request.scope,
    invocation: request.invocation,
    environment: request.environment,
    transfers: request.transfers.map(({ name, direction }) => ({ name, direction })),
    limits: request.limits,
    stdinSha256: request.stdin == null
      ? null
      : createHash('sha256').update(String(request.stdin), 'utf8').digest('hex'),
  };
  return `execution-${createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')}`;
}

export class RepositoryEnvironmentExecution {
  #status;
  #open;

  constructor({ status, open }) {
    this.#status = normalizeRepositoryExecutionStatus(status);
    if (typeof open !== 'function') throw new TypeError('repository execution open must be a function');
    this.#open = open;
  }

  inspect() { return this.#status; }

  async execute(rawRequest) {
    const request = normalizeRepositoryExecutionRequest(rawRequest);
    if (this.#status.ready !== true) {
      throw new PolicyError(`repository execution is unavailable: ${this.#status.reason ?? 'execution boundary is not ready'}`);
    }
    ensureActive(request.signal);

    const session = assertSession(await this.#open(structuredClone(request.scope)));
    try {
      ensureActive(request.signal);
      const prepared = await session.prepare({ signal: request.signal, onActivity: request.onActivity });
      const preparedEvidence = preparedIdentity(prepared);
      const identity = evidenceIdentity(preparedEvidence, request);

      for (const transfer of request.transfers) {
        ensureActive(request.signal);
        if (transfer.direction === 'input') {
          await session.input(transfer.name, transfer.port, { signal: request.signal });
        }
      }

      ensureActive(request.signal);
      const outcome = await session.run({
        operation: request.operation,
        invocation: structuredClone(request.invocation),
        environment: structuredClone(request.environment),
        transfers: request.transfers.map(({ name, direction }) => ({ name, direction })),
        limits: structuredClone(request.limits),
        stdin: request.stdin,
        signal: request.signal,
        onActivity: request.onActivity,
      });
      const result = observedOutcome(outcome);

      if (result.timedOut !== true && result.aborted !== true) {
        ensureActive(request.signal);
        for (const transfer of request.transfers) {
          ensureActive(request.signal);
          if (transfer.direction === 'output') {
            await session.output(transfer.name, transfer.port, { signal: request.signal });
          }
        }
        ensureActive(request.signal);
        await session.collect({ identity: preparedEvidence, operation: request.operation, signal: request.signal });
      }

      return normalizeRepositoryExecutionResult({
        protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        timedOut: result.timedOut === true,
        aborted: result.aborted === true,
        outputTruncated: result.outputTruncated === true,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        startedAt: result.startedAt ?? null,
        finishedAt: result.finishedAt ?? null,
        lastOutputAt: result.lastOutputAt ?? null,
        evidence: { identity, scope: request.scope },
      });
    } finally {
      if (typeof session.close === 'function') await session.close();
    }
  }

  async cleanup(rawRequest) {
    const request = normalizeRepositoryExecutionCleanupRequest(rawRequest);
    if (this.#status.ready !== true) {
      throw new PolicyError(`repository execution is unavailable: ${this.#status.reason ?? 'execution boundary is not ready'}`);
    }
    ensureActive(request.signal);
    const session = assertSession(await this.#open(structuredClone(request.scope)));
    try {
      if (typeof session.cleanup !== 'function') throw new PolicyError('repository execution session does not provide cleanup');
      const observed = cleanupEvidence(await session.cleanup({ resource: request.resource, signal: request.signal }));
      ensureActive(request.signal);
      return normalizeRepositoryExecutionCleanupResult({
        protocol: REPOSITORY_EXECUTION_CLEANUP_RESULT_PROTOCOL,
        resource: request.resource,
        state: observed.state,
        removed: observed.removed,
        evidence: { identity: observed.identity, scope: request.scope },
      });
    } finally {
      if (typeof session.close === 'function') await session.close();
    }
  }
}
