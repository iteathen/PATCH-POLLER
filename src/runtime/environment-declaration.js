import { createHash } from 'node:crypto';

export const ENVIRONMENT_DECLARATION_PROTOCOL = 'devbridge/environment-declaration-v1';
export const ENVIRONMENT_DECLARATION_RECORD_PROTOCOL = 'devbridge/environment-declaration-record-v1';
export const ENVIRONMENT_RECONSTRUCTABILITY = Object.freeze({
  READY: 'fully-reconstructable',
  DISCOVERY: 'reconstructable-after-local-discovery',
  SETUP: 'setup-reentry-required',
  UNSAFE: 'ambiguous-or-unowned',
});
export const ENVIRONMENT_STATE_CLASSES = Object.freeze([
  'authority',
  'materialization',
  'reseedable',
  'disposable',
  'protected',
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_WORKSPACES = 4096;
const MAX_REQUIREMENTS = 256;
const MAX_PROTECTED_CLASSES = 128;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function uniqueIds(raw, name, maximum) {
  if (!Array.isArray(raw) || raw.length > maximum) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => safeId(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values);
}

function normalizeGuest(raw) {
  const value = requireObject(raw, 'environment declaration.guest');
  onlyKeys(value, new Set(['family', 'generation']), 'environment declaration.guest');
  return Object.freeze({
    family: safeId(value.family, 'environment declaration.guest.family'),
    generation: safeId(value.generation, 'environment declaration.guest.generation'),
  });
}

function normalizeImage(raw) {
  const value = requireObject(raw, 'environment declaration.image');
  onlyKeys(value, new Set(['identity', 'generation']), 'environment declaration.image');
  return Object.freeze({
    identity: safeId(value.identity, 'environment declaration.image.identity'),
    generation: safeId(value.generation, 'environment declaration.image.generation'),
  });
}

function normalizeResources(raw) {
  const value = requireObject(raw, 'environment declaration.resources');
  onlyKeys(value, new Set(['memoryBytes', 'processorCount']), 'environment declaration.resources');
  return Object.freeze({
    memoryBytes: positiveSafeInteger(value.memoryBytes, 'environment declaration.resources.memoryBytes'),
    processorCount: positiveSafeInteger(value.processorCount, 'environment declaration.resources.processorCount'),
  });
}

function normalizeRequirement(raw, name) {
  const value = requireObject(raw, `environment declaration.${name}`);
  onlyKeys(value, new Set(['requirement']), `environment declaration.${name}`);
  return Object.freeze({ requirement: safeId(value.requirement, `environment declaration.${name}.requirement`) });
}

function normalizeBootstrap(raw) {
  const value = requireObject(raw, 'environment declaration.bootstrap');
  onlyKeys(value, new Set(['generation', 'requirements']), 'environment declaration.bootstrap');
  return Object.freeze({
    generation: safeId(value.generation, 'environment declaration.bootstrap.generation'),
    requirements: uniqueIds(value.requirements, 'environment declaration.bootstrap.requirements', MAX_REQUIREMENTS),
  });
}

function normalizeWorkspaces(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_WORKSPACES) throw new TypeError('environment declaration.workspaces is invalid');
  const identities = new Set();
  const values = raw.map((rawWorkspace, index) => {
    const value = requireObject(rawWorkspace, `environment declaration.workspaces[${index}]`);
    onlyKeys(value, new Set(['identity', 'authority']), `environment declaration.workspaces[${index}]`);
    const identity = safeId(value.identity, `environment declaration.workspaces[${index}].identity`);
    if (identities.has(identity)) throw new TypeError('environment declaration.workspaces contains duplicate identities');
    identities.add(identity);
    return Object.freeze({
      identity,
      authority: safeId(value.authority, `environment declaration.workspaces[${index}].authority`),
    });
  });
  return Object.freeze(values);
}

export function normalizeEnvironmentDeclaration(raw) {
  const value = requireObject(raw, 'environment declaration');
  onlyKeys(value, new Set([
    'protocol', 'profile', 'schemaGeneration', 'guest', 'image', 'resources', 'boot', 'network',
    'bootstrap', 'enrollment', 'workspaces', 'protectedStateClasses',
  ]), 'environment declaration');
  if (value.protocol !== ENVIRONMENT_DECLARATION_PROTOCOL) throw new TypeError('environment declaration protocol is unsupported');
  return Object.freeze({
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: safeId(value.profile, 'environment declaration.profile'),
    schemaGeneration: safeId(value.schemaGeneration, 'environment declaration.schemaGeneration'),
    guest: normalizeGuest(value.guest),
    image: normalizeImage(value.image),
    resources: normalizeResources(value.resources),
    boot: normalizeRequirement(value.boot, 'boot'),
    network: normalizeRequirement(value.network, 'network'),
    bootstrap: normalizeBootstrap(value.bootstrap),
    enrollment: normalizeRequirement(value.enrollment, 'enrollment'),
    workspaces: normalizeWorkspaces(value.workspaces),
    protectedStateClasses: uniqueIds(value.protectedStateClasses, 'environment declaration.protectedStateClasses', MAX_PROTECTED_CLASSES),
  });
}

export function logicalEnvironmentIdentity(profile) {
  const normalized = safeId(profile, 'environment profile');
  const digest = createHash('sha256').update('devbridge/logical-environment-v1\0', 'utf8').update(normalized, 'utf8').digest('hex');
  return `environment-${digest.slice(0, 32)}`;
}

export function classifyEnvironmentReconstructability({ declaration = null, authority = 'verified', completion = 'complete' } = {}) {
  if (!['verified', 'unverified', 'ambiguous'].includes(authority)) throw new TypeError('environment authority classification is invalid');
  if (!['complete', 'discoverable', 'setup-required'].includes(completion)) throw new TypeError('environment declaration completion is invalid');
  if (authority !== 'verified') return ENVIRONMENT_RECONSTRUCTABILITY.UNSAFE;
  if (completion === 'discoverable') return ENVIRONMENT_RECONSTRUCTABILITY.DISCOVERY;
  if (completion === 'setup-required') return ENVIRONMENT_RECONSTRUCTABILITY.SETUP;
  normalizeEnvironmentDeclaration(declaration);
  return ENVIRONMENT_RECONSTRUCTABILITY.READY;
}

function declarationRecord(raw) {
  const value = requireObject(raw, 'environment declaration record');
  onlyKeys(value, new Set(['protocol', 'identity', 'revision', 'declaration', 'updatedAt']), 'environment declaration record');
  if (value.protocol !== ENVIRONMENT_DECLARATION_RECORD_PROTOCOL) throw new TypeError('environment declaration record protocol is unsupported');
  const declaration = normalizeEnvironmentDeclaration(value.declaration);
  const identity = logicalEnvironmentIdentity(declaration.profile);
  if (value.identity !== identity) throw new TypeError('environment declaration record identity does not match its declaration');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('environment declaration record revision is invalid');
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new TypeError('environment declaration record timestamp is invalid');
  return Object.freeze({
    protocol: ENVIRONMENT_DECLARATION_RECORD_PROTOCOL,
    identity,
    revision: value.revision,
    declaration,
    updatedAt: value.updatedAt,
  });
}

function sameDeclaration(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class EnvironmentDeclarationRegistry {
  #port;
  #now;

  constructor({ port, now = () => new Date().toISOString() } = {}) {
    if (!port || typeof port.load !== 'function' || typeof port.save !== 'function' || typeof port.scan !== 'function') {
      throw new TypeError('environment declaration persistence port is incomplete');
    }
    if (typeof now !== 'function') throw new TypeError('environment declaration clock is invalid');
    this.#port = port;
    this.#now = now;
  }

  async get(identity) {
    const raw = await this.#port.load(safeId(identity, 'environment identity'));
    return raw == null ? null : declarationRecord(raw);
  }

  async list() {
    const values = await this.#port.scan();
    if (!Array.isArray(values)) throw new TypeError('environment declaration persistence scan is invalid');
    return Object.freeze(values.map((value) => declarationRecord(value)));
  }

  async register(rawDeclaration, { expectedRevision = null } = {}) {
    const declaration = normalizeEnvironmentDeclaration(rawDeclaration);
    const identity = logicalEnvironmentIdentity(declaration.profile);
    const currentRaw = await this.#port.load(identity);
    const current = currentRaw == null ? null : declarationRecord(currentRaw);
    if (current && sameDeclaration(current.declaration, declaration)) return Object.freeze({ changed: false, record: current });
    if (current == null) {
      if (expectedRevision != null) throw new Error('environment declaration revision expectation does not match absent state');
    } else if (expectedRevision !== current.revision) {
      throw new Error('environment declaration revision changed; re-read before replacing local authority');
    }
    const next = Object.freeze({
      protocol: ENVIRONMENT_DECLARATION_RECORD_PROTOCOL,
      identity,
      revision: (current?.revision ?? 0) + 1,
      declaration,
      updatedAt: this.#now(),
    });
    await this.#port.save(identity, next);
    return Object.freeze({ changed: true, record: next });
  }
}
