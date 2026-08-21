import { PolicyError } from '../errors.js';

export const REPOSITORY_EXECUTION_REQUEST_PROTOCOL = 'devbridge/repository-execution-request-v1';
export const REPOSITORY_EXECUTION_STATUS_PROTOCOL = 'devbridge/repository-execution-status-v1';
export const REPOSITORY_EXECUTION_RESULT_PROTOCOL = 'devbridge/repository-execution-result-v1';
export const REPOSITORY_EXECUTION_CLEANUP_RESULT_PROTOCOL = 'devbridge/repository-execution-cleanup-result-v1';

const SAFE_OPERATION = /^[A-Za-z0-9_.:-]{1,160}$/u;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_ARGUMENTS = 256;
const MAX_TRANSFERS = 64;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 28_800_000;
const MAX_OUTPUT_BYTES = 16_777_216;
const MAX_REASON_BYTES = 1_024;
const ARGUMENT_KINDS = new Set(['literal', 'input', 'output', 'scratch']);
const TRANSFER_DIRECTIONS = new Set(['input', 'output']);
const CLEANUP_RESOURCES = new Set(['scratch']);
const RESERVED_ENVIRONMENT_NAMES = new Set([
  'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);
const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:API_?KEY|AUTHORIZATION|CREDENTIALS?|KEYS?|PASSWORD|PASSWD|PRIVATE_?KEY|SECRETS?|TOKENS?)(?:_|$)/iu;
const REQUEST_KEYS = new Set([
  'protocol', 'operation', 'scope', 'invocation', 'environment', 'transfers', 'limits',
  'stdin', 'signal', 'onActivity',
]);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PolicyError(`${name}.${key} is not allowed`);
}

function boundedString(value, name, { maxBytes = 8_192, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new PolicyError(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  }
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new PolicyError(`${name} is not bounded`);
  return value;
}

function safeInteger(value, name, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PolicyError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boundedReason(value) {
  const reason = value == null ? 'no repository execution implementation is configured' : String(value).trim();
  if (!reason || Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new PolicyError('repository execution unavailable reason must be a bounded printable string');
  }
  return reason;
}

function logicalPath(value, name) {
  const text = boundedString(value ?? '.', name, { maxBytes: 4_096 });
  const portable = text.replace(/\\/gu, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')) {
    throw new PolicyError(`${name} must be environment-relative`);
  }
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '..')) throw new PolicyError(`${name} must not contain traversal segments`);
  return portable || '.';
}

function normalizeScope(raw) {
  const scope = requireObject(raw, 'repository execution scope');
  onlyKeys(scope, new Set(['repository', 'repositoryId', 'runId']), 'repository execution scope');
  if (typeof scope.repository !== 'string' || !REPOSITORY.test(scope.repository)) {
    throw new PolicyError('repository execution scope.repository is invalid');
  }
  if (scope.repositoryId != null && (typeof scope.repositoryId !== 'string' || !/^\d+$/u.test(scope.repositoryId))) {
    throw new PolicyError('repository execution scope.repositoryId must be a numeric string when present');
  }
  if (typeof scope.runId !== 'string' || !SAFE_NAME.test(scope.runId)) {
    throw new PolicyError('repository execution scope.runId is invalid');
  }
  return { repository: scope.repository, repositoryId: scope.repositoryId ?? null, runId: scope.runId };
}

function normalizeArgument(raw, index) {
  if (typeof raw === 'string') {
    const value = boundedString(raw, `repository execution invocation.arguments[${index}]`, { allowEmpty: true });
    const portable = value.replace(/\\/gu, '/');
    if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')) {
      throw new PolicyError(`repository execution invocation.arguments[${index}] must not expose an absolute path`);
    }
    return { kind: 'literal', value };
  }
  const argument = requireObject(raw, `repository execution invocation.arguments[${index}]`);
  onlyKeys(argument, new Set(['kind', 'name']), `repository execution invocation.arguments[${index}]`);
  if (!ARGUMENT_KINDS.has(argument.kind) || argument.kind === 'literal') {
    throw new PolicyError(`repository execution invocation.arguments[${index}].kind is invalid`);
  }
  if (typeof argument.name !== 'string' || !SAFE_NAME.test(argument.name)) {
    throw new PolicyError(`repository execution invocation.arguments[${index}].name is invalid`);
  }
  return { kind: argument.kind, name: argument.name };
}

function normalizeInvocation(raw) {
  const invocation = requireObject(raw, 'repository execution invocation');
  onlyKeys(invocation, new Set(['tool', 'arguments', 'workingDirectory']), 'repository execution invocation');
  if (typeof invocation.tool !== 'string' || !SAFE_NAME.test(invocation.tool)) {
    throw new PolicyError('repository execution invocation.tool must be a logical tool identity');
  }
  if (!Array.isArray(invocation.arguments) || invocation.arguments.length > MAX_ARGUMENTS) {
    throw new PolicyError(`repository execution invocation.arguments must contain at most ${MAX_ARGUMENTS} entries`);
  }
  return {
    tool: invocation.tool,
    arguments: invocation.arguments.map(normalizeArgument),
    workingDirectory: logicalPath(invocation.workingDirectory ?? '.', 'repository execution invocation.workingDirectory'),
  };
}

function normalizeEnvironment(raw = {}) {
  const environment = requireObject(raw, 'repository execution environment');
  if (Object.keys(environment).length > 128) throw new PolicyError('repository execution environment is too large');
  const normalized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!ENV_NAME.test(name)) throw new PolicyError(`repository execution environment.${name} name is invalid`);
    if (RESERVED_ENVIRONMENT_NAMES.has(name.toUpperCase()) || SENSITIVE_ENVIRONMENT_NAME.test(name)) {
      throw new PolicyError(`repository execution environment.${name} is reserved by the execution boundary`);
    }
    normalized[name] = boundedString(value, `repository execution environment.${name}`, { maxBytes: 16_384, allowEmpty: true });
  }
  return normalized;
}

function normalizeTransfers(raw = []) {
  if (!Array.isArray(raw) || raw.length > MAX_TRANSFERS) {
    throw new PolicyError(`repository execution transfers must contain at most ${MAX_TRANSFERS} entries`);
  }
  const names = new Set();
  return raw.map((entry, index) => {
    const transfer = requireObject(entry, `repository execution transfers[${index}]`);
    onlyKeys(transfer, new Set(['name', 'direction', 'port']), `repository execution transfers[${index}]`);
    if (typeof transfer.name !== 'string' || !SAFE_NAME.test(transfer.name)) {
      throw new PolicyError(`repository execution transfers[${index}].name is invalid`);
    }
    if (names.has(transfer.name)) throw new PolicyError(`repository execution transfer name ${transfer.name} is duplicated`);
    names.add(transfer.name);
    if (!TRANSFER_DIRECTIONS.has(transfer.direction)) throw new PolicyError(`repository execution transfers[${index}].direction is invalid`);
    const port = requireObject(transfer.port, `repository execution transfers[${index}].port`);
    const method = transfer.direction === 'input' ? 'read' : 'write';
    if (typeof port[method] !== 'function') {
      throw new PolicyError(`repository execution ${transfer.direction} transfer ${transfer.name} must provide ${method}()`);
    }
    return { name: transfer.name, direction: transfer.direction, port };
  });
}

function normalizeLimits(raw = {}) {
  const limits = requireObject(raw, 'repository execution limits');
  onlyKeys(limits, new Set(['timeoutMs', 'maxOutputBytes']), 'repository execution limits');
  return {
    timeoutMs: safeInteger(limits.timeoutMs ?? 120_000, 'repository execution limits.timeoutMs', { min: 1_000, max: MAX_TIMEOUT_MS }),
    maxOutputBytes: safeInteger(limits.maxOutputBytes ?? 512 * 1024, 'repository execution limits.maxOutputBytes', { min: 1_024, max: MAX_OUTPUT_BYTES }),
  };
}

function assertTransferArguments(invocation, transfers) {
  const byName = new Map(transfers.map((transfer) => [transfer.name, transfer]));
  for (const argument of invocation.arguments) {
    if (argument.kind === 'literal' || argument.kind === 'scratch') continue;
    const transfer = byName.get(argument.name);
    if (!transfer) throw new PolicyError(`repository execution argument references unknown transfer ${argument.name}`);
    if (transfer.direction !== argument.kind) {
      throw new PolicyError(`repository execution argument ${argument.name} direction does not match ${argument.kind}`);
    }
  }
}

export function normalizeRepositoryExecutionRequest(raw) {
  const request = requireObject(raw, 'repository execution request');
  onlyKeys(request, REQUEST_KEYS, 'repository execution request');
  if (request.protocol !== REPOSITORY_EXECUTION_REQUEST_PROTOCOL) throw new PolicyError('repository execution request protocol is unsupported');
  if (typeof request.operation !== 'string' || !SAFE_OPERATION.test(request.operation)) throw new PolicyError('repository execution request operation is invalid');
  const scope = normalizeScope(request.scope);
  const invocation = normalizeInvocation(request.invocation);
  const environment = normalizeEnvironment(request.environment ?? {});
  const transfers = normalizeTransfers(request.transfers ?? []);
  const limits = normalizeLimits(request.limits ?? {});
  assertTransferArguments(invocation, transfers);
  if (request.stdin != null && (typeof request.stdin !== 'string' || Buffer.byteLength(request.stdin, 'utf8') > MAX_STDIN_BYTES)) {
    throw new PolicyError('repository execution request.stdin must be null or bounded text');
  }
  if (request.signal != null && typeof request.signal !== 'object') throw new PolicyError('repository execution request.signal is invalid');
  if (request.onActivity != null && typeof request.onActivity !== 'function') throw new PolicyError('repository execution request.onActivity is invalid');
  return {
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: request.operation,
    scope,
    invocation,
    environment,
    transfers,
    limits,
    stdin: request.stdin ?? null,
    signal: request.signal ?? null,
    onActivity: request.onActivity ?? null,
  };
}

export function normalizeRepositoryExecutionCleanupRequest(raw) {
  const request = requireObject(raw, 'repository execution cleanup request');
  onlyKeys(request, new Set(['scope', 'resource', 'signal']), 'repository execution cleanup request');
  const scope = normalizeScope(request.scope);
  if (typeof request.resource !== 'string' || !CLEANUP_RESOURCES.has(request.resource)) {
    throw new PolicyError('repository execution cleanup resource is invalid');
  }
  if (request.signal != null && typeof request.signal !== 'object') throw new PolicyError('repository execution cleanup signal is invalid');
  return { scope, resource: request.resource, signal: request.signal ?? null };
}

function nullableBoundedString(value, name, { maxBytes = 8_192 } = {}) {
  if (value == null) return null;
  return boundedString(value, name, { maxBytes, allowEmpty: true });
}

export function normalizeRepositoryExecutionResult(raw) {
  const result = requireObject(raw, 'repository execution result');
  onlyKeys(result, new Set([
    'protocol', 'exitCode', 'signal', 'timedOut', 'aborted', 'outputTruncated',
    'stdout', 'stderr', 'startedAt', 'finishedAt', 'lastOutputAt', 'evidence',
  ]), 'repository execution result');
  if (result.protocol !== REPOSITORY_EXECUTION_RESULT_PROTOCOL) throw new PolicyError('repository execution result protocol is unsupported');
  if (result.exitCode != null && (!Number.isInteger(result.exitCode) || result.exitCode < -1 || result.exitCode > 255)) {
    throw new PolicyError('repository execution result.exitCode is invalid');
  }
  for (const name of ['timedOut', 'aborted', 'outputTruncated']) {
    if (typeof result[name] !== 'boolean') throw new PolicyError(`repository execution result.${name} must be boolean`);
  }
  const evidence = requireObject(result.evidence, 'repository execution result.evidence');
  onlyKeys(evidence, new Set(['identity', 'scope']), 'repository execution result.evidence');
  if (typeof evidence.identity !== 'string' || !SAFE_NAME.test(evidence.identity)) {
    throw new PolicyError('repository execution result.evidence.identity is invalid');
  }
  const scope = normalizeScope(evidence.scope);
  return {
    protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
    exitCode: result.exitCode ?? null,
    signal: nullableBoundedString(result.signal, 'repository execution result.signal', { maxBytes: 128 }),
    timedOut: result.timedOut,
    aborted: result.aborted,
    outputTruncated: result.outputTruncated,
    stdout: boundedString(result.stdout ?? '', 'repository execution result.stdout', { maxBytes: MAX_OUTPUT_BYTES, allowEmpty: true }),
    stderr: boundedString(result.stderr ?? '', 'repository execution result.stderr', { maxBytes: MAX_OUTPUT_BYTES, allowEmpty: true }),
    startedAt: nullableBoundedString(result.startedAt, 'repository execution result.startedAt', { maxBytes: 128 }),
    finishedAt: nullableBoundedString(result.finishedAt, 'repository execution result.finishedAt', { maxBytes: 128 }),
    lastOutputAt: nullableBoundedString(result.lastOutputAt, 'repository execution result.lastOutputAt', { maxBytes: 128 }),
    evidence: { identity: evidence.identity, scope },
  };
}

export function normalizeRepositoryExecutionCleanupResult(raw) {
  const result = requireObject(raw, 'repository execution cleanup result');
  onlyKeys(result, new Set(['protocol', 'resource', 'state', 'removed', 'evidence']), 'repository execution cleanup result');
  if (result.protocol !== REPOSITORY_EXECUTION_CLEANUP_RESULT_PROTOCOL) throw new PolicyError('repository execution cleanup result protocol is unsupported');
  if (typeof result.resource !== 'string' || !CLEANUP_RESOURCES.has(result.resource)) throw new PolicyError('repository execution cleanup result.resource is invalid');
  if (result.state !== 'verified-absent') throw new PolicyError('repository execution cleanup result.state is invalid');
  if (typeof result.removed !== 'boolean') throw new PolicyError('repository execution cleanup result.removed must be boolean');
  const evidence = requireObject(result.evidence, 'repository execution cleanup result.evidence');
  onlyKeys(evidence, new Set(['identity', 'scope']), 'repository execution cleanup result.evidence');
  if (typeof evidence.identity !== 'string' || !SAFE_NAME.test(evidence.identity)) throw new PolicyError('repository execution cleanup result.evidence.identity is invalid');
  return {
    protocol: REPOSITORY_EXECUTION_CLEANUP_RESULT_PROTOCOL,
    resource: result.resource,
    state: result.state,
    removed: result.removed,
    evidence: { identity: evidence.identity, scope: normalizeScope(evidence.scope) },
  };
}

export function unavailableRepositoryExecutionStatus(reason = null) {
  return Object.freeze({
    protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
    state: 'unavailable',
    ready: false,
    identity: null,
    reason: boundedReason(reason),
  });
}

export function normalizeRepositoryExecutionStatus(raw) {
  const status = requireObject(raw, 'repository execution status');
  onlyKeys(status, new Set(['protocol', 'state', 'ready', 'identity', 'reason']), 'repository execution status');
  if (status.protocol !== REPOSITORY_EXECUTION_STATUS_PROTOCOL) throw new PolicyError('repository execution status protocol is unsupported');
  if (!['ready', 'unavailable', 'degraded'].includes(status.state)) throw new PolicyError('repository execution status.state is invalid');
  if (typeof status.ready !== 'boolean') throw new PolicyError('repository execution status.ready must be boolean');
  if ((status.state === 'ready') !== status.ready) throw new PolicyError('repository execution status ready/state disagree');
  if (status.identity != null && (typeof status.identity !== 'string' || !SAFE_NAME.test(status.identity))) {
    throw new PolicyError('repository execution status.identity is invalid');
  }
  if (status.ready && status.identity == null) throw new PolicyError('ready repository execution status requires identity');
  const reason = status.reason == null ? null : boundedReason(status.reason);
  if (!status.ready && reason == null) throw new PolicyError('unready repository execution status requires reason');
  return Object.freeze({ protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: status.state, ready: status.ready, identity: status.identity ?? null, reason });
}

export class UnavailableRepositoryExecution {
  #status;
  constructor({ reason = null } = {}) { this.#status = unavailableRepositoryExecutionStatus(reason); }
  inspect() { return this.#status; }
  async execute(rawRequest) {
    normalizeRepositoryExecutionRequest(rawRequest);
    throw new PolicyError(`repository execution is unavailable: ${this.#status.reason}`);
  }
  async cleanup(rawRequest) {
    normalizeRepositoryExecutionCleanupRequest(rawRequest);
    throw new PolicyError(`repository execution is unavailable: ${this.#status.reason}`);
  }
}

export function assertRepositoryExecutionContract(value) {
  if (!value || typeof value.inspect !== 'function' || typeof value.execute !== 'function') {
    throw new TypeError('repository execution must provide inspect() and execute()');
  }
  if (value.cleanup != null && typeof value.cleanup !== 'function') throw new TypeError('repository execution cleanup must be a function when present');
  normalizeRepositoryExecutionStatus(value.inspect());
  return value;
}