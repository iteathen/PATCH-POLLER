import { logicalEnvironmentIdentity, normalizeEnvironmentDeclaration } from './environment-declaration.js';
import { environmentObservationCondition, normalizeEnvironmentObservation } from './environment-observation.js';

export const ENVIRONMENT_CONSTRUCTION_PROTOCOL = 'devbridge/environment-construction-v1';
export const ENVIRONMENT_CONSTRUCTION_STAGES = Object.freeze([
  'image',
  'resources',
  'materialization',
  'preparation',
  'workspaces',
  'readiness',
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function positive(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`); return value; }
function timestamp(value, name) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`); return value; }

function normalizeCheckpoint(raw) {
  const value = requireObject(raw, 'environment construction checkpoint');
  onlyKeys(value, new Set(['protocol', 'environmentIdentity', 'operationId', 'declarationRevision', 'completed', 'implementationGeneration', 'observation', 'updatedAt']), 'environment construction checkpoint');
  if (value.protocol !== ENVIRONMENT_CONSTRUCTION_PROTOCOL) throw new TypeError('environment construction checkpoint protocol is unsupported');
  if (!Array.isArray(value.completed) || value.completed.length > ENVIRONMENT_CONSTRUCTION_STAGES.length) throw new TypeError('environment construction completed stages are invalid');
  for (let index = 0; index < value.completed.length; index += 1) {
    if (value.completed[index] !== ENVIRONMENT_CONSTRUCTION_STAGES[index]) throw new TypeError('environment construction completed stages must be contiguous');
  }
  const observation = value.observation == null ? null : normalizeEnvironmentObservation(value.observation);
  if (observation != null && value.completed.at(-1) !== 'readiness') throw new TypeError('environment construction observation is valid only after readiness');
  return Object.freeze({
    protocol: ENVIRONMENT_CONSTRUCTION_PROTOCOL,
    environmentIdentity: safeId(value.environmentIdentity, 'environment construction environmentIdentity'),
    operationId: safeId(value.operationId, 'environment construction operationId'),
    declarationRevision: positive(value.declarationRevision, 'environment construction declarationRevision'),
    completed: Object.freeze([...value.completed]),
    implementationGeneration: value.implementationGeneration == null ? null : safeId(value.implementationGeneration, 'environment construction implementationGeneration'),
    observation,
    updatedAt: timestamp(value.updatedAt, 'environment construction updatedAt'),
  });
}

function assertPort(value, name, method = 'ensure') {
  if (!value || typeof value[method] !== 'function') throw new TypeError(`environment construction ${name} contract is incomplete`);
  return value;
}

function readyResult(raw, name) {
  const value = requireObject(raw, `environment construction ${name} result`);
  if (value.ready !== true) throw new Error(`environment construction ${name} did not become ready`);
  return value;
}

function generationResult(raw, name, expected = null) {
  const value = readyResult(raw, name);
  const generation = safeId(value.implementationGeneration, `environment construction ${name} implementationGeneration`);
  if (expected != null && generation !== expected) throw new Error(`environment construction ${name} implementation generation changed`);
  return { value, generation };
}

function requestFor(input, declaration) {
  return Object.freeze({
    environmentIdentity: input.environmentIdentity,
    operationId: input.operationId,
    declarationRevision: input.declarationRevision,
    declaration,
  });
}

export class EnvironmentConstructionPipeline {
  #checkpoint;
  #image;
  #resources;
  #materialization;
  #preparation;
  #workspaces;
  #readiness;
  #now;

  constructor({ checkpoint, image, resources, materialization, preparation, workspaces, readiness, now = () => new Date().toISOString() } = {}) {
    if (!checkpoint || typeof checkpoint.load !== 'function' || typeof checkpoint.save !== 'function' || typeof checkpoint.delete !== 'function') throw new TypeError('environment construction checkpoint contract is incomplete');
    this.#checkpoint = checkpoint;
    this.#image = assertPort(image, 'image');
    this.#resources = assertPort(resources, 'resources');
    this.#materialization = assertPort(materialization, 'materialization');
    this.#preparation = assertPort(preparation, 'preparation');
    this.#workspaces = assertPort(workspaces, 'workspaces');
    this.#readiness = assertPort(readiness, 'readiness', 'verify');
    if (typeof now !== 'function') throw new TypeError('environment construction clock is invalid');
    this.#now = now;
  }

  async #load(input) {
    const raw = await this.#checkpoint.load(input.operationId);
    if (raw == null) {
      return normalizeCheckpoint({
        protocol: ENVIRONMENT_CONSTRUCTION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        operationId: input.operationId,
        declarationRevision: input.declarationRevision,
        completed: [],
        implementationGeneration: null,
        observation: null,
        updatedAt: this.#now(),
      });
    }
    const current = normalizeCheckpoint(raw);
    if (current.environmentIdentity !== input.environmentIdentity || current.declarationRevision !== input.declarationRevision) {
      throw new Error('environment construction checkpoint no longer matches declaration authority');
    }
    return current;
  }

  async #save(current, stage, { implementationGeneration = current.implementationGeneration, observation = current.observation } = {}) {
    const next = normalizeCheckpoint({
      ...current,
      completed: [...current.completed, stage],
      implementationGeneration,
      observation,
      updatedAt: this.#now(),
    });
    await this.#checkpoint.save(current.operationId, next);
    return next;
  }

  async run(rawInput) {
    const input = requireObject(rawInput, 'environment construction request');
    onlyKeys(input, new Set(['environmentIdentity', 'operationId', 'declarationRevision', 'declaration']), 'environment construction request');
    const declaration = normalizeEnvironmentDeclaration(input.declaration);
    const normalized = {
      environmentIdentity: safeId(input.environmentIdentity, 'environment construction environmentIdentity'),
      operationId: safeId(input.operationId, 'environment construction operationId'),
      declarationRevision: positive(input.declarationRevision, 'environment construction declarationRevision'),
    };
    if (logicalEnvironmentIdentity(declaration.profile) !== normalized.environmentIdentity) throw new Error('environment construction declaration belongs to another logical environment');
    const request = requestFor(normalized, declaration);
    let current = await this.#load(normalized);

    for (let index = current.completed.length; index < ENVIRONMENT_CONSTRUCTION_STAGES.length; index += 1) {
      const stage = ENVIRONMENT_CONSTRUCTION_STAGES[index];
      if (stage === 'image') {
        readyResult(await this.#image.ensure(Object.freeze({ ...request, image: declaration.image, bootstrapGeneration: declaration.bootstrap.generation })), 'image');
        current = await this.#save(current, stage);
      } else if (stage === 'resources') {
        readyResult(await this.#resources.ensure(Object.freeze({ ...request, profile: declaration.profile, resources: declaration.resources, boot: declaration.boot, network: declaration.network })), 'resources');
        current = await this.#save(current, stage);
      } else if (stage === 'materialization') {
        const result = generationResult(await this.#materialization.ensure(request), 'materialization');
        current = await this.#save(current, stage, { implementationGeneration: result.generation });
      } else if (stage === 'preparation') {
        const result = generationResult(await this.#preparation.ensure(Object.freeze({ ...request, implementationGeneration: current.implementationGeneration, enrollment: declaration.enrollment, bootstrap: declaration.bootstrap })), 'preparation', current.implementationGeneration);
        current = await this.#save(current, stage, { implementationGeneration: result.generation });
      } else if (stage === 'workspaces') {
        const result = generationResult(await this.#workspaces.ensure(Object.freeze({ ...request, implementationGeneration: current.implementationGeneration, workspaces: declaration.workspaces })), 'workspaces', current.implementationGeneration);
        current = await this.#save(current, stage, { implementationGeneration: result.generation });
      } else if (stage === 'readiness') {
        const result = generationResult(await this.#readiness.verify(Object.freeze({ ...request, implementationGeneration: current.implementationGeneration })), 'readiness', current.implementationGeneration);
        const observation = normalizeEnvironmentObservation(result.value.observation);
        if (observation.environmentIdentity !== normalized.environmentIdentity || observation.declarationRevision !== normalized.declarationRevision) throw new Error('environment construction readiness observation does not match declaration authority');
        if (observation.implementationGeneration !== current.implementationGeneration) throw new Error('environment construction readiness observation generation changed');
        if (environmentObservationCondition(observation) !== 'healthy') throw new Error('environment construction readiness observation is not healthy');
        current = await this.#save(current, stage, { implementationGeneration: result.generation, observation });
      }
    }

    return Object.freeze({
      state: 'ready',
      environmentIdentity: current.environmentIdentity,
      operationId: current.operationId,
      declarationRevision: current.declarationRevision,
      implementationGeneration: current.implementationGeneration,
      observation: current.observation,
    });
  }

  async clear(operationId) {
    await this.#checkpoint.delete(safeId(operationId, 'environment construction operationId'));
    return Object.freeze({ cleared: true });
  }
}
