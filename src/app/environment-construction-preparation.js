import path from 'node:path';
import { createEnvironmentBootstrap } from './environment-bootstrap.js';
import { createLinuxAccessPreparation } from './linux-access-preparation.js';
import { executionProfileSubject } from './execution-profile-routing.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { SshAccessMaterial } from '../runtime/ssh-access-material.js';
import { SshAccessProbe } from '../runtime/ssh-access-probe.js';
import { HyperVGuestFileDelivery } from '../runtime/providers/hyperv-guest-file-delivery.js';

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function sameRequirement(left, right) {
  return left?.requirement === right?.requirement;
}

function sameBootstrap(left, right) {
  return left?.generation === right?.generation
    && Array.isArray(left?.requirements)
    && Array.isArray(right?.requirements)
    && JSON.stringify(left.requirements) === JSON.stringify(right.requirements);
}

function guestKind(guest) {
  if (guest?.family === 'ubuntu') return 'linux';
  if (guest?.family === 'windows-11') return 'windows';
  throw new Error(`environment guest family requires setup re-entry: ${String(guest?.family ?? 'missing')}`);
}

function safeReason(error) {
  return String(error?.message ?? error ?? 'environment preparation is unavailable').slice(0, 2048);
}

export async function createLocalEnvironmentAccess({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  guest,
  windowsAccess = null,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment access stateDirectory is required');
  if (typeof invoke !== 'function') throw new TypeError('environment access invocation contract is invalid');
  const family = guestKind(guest);
  if (family === 'linux' && platform === 'linux') {
    return Object.freeze({
      connection: async () => Object.freeze({ family: 'linux' }),
      prepare: null,
    });
  }
  if (family === 'linux' && platform === 'win32') {
    const root = path.join(path.resolve(stateDirectory), 'environment-foundation');
    const identity = await loadOrCreateLocalIdentity({ directory: root });
    const material = new SshAccessMaterial({ directory: path.join(root, 'access', 'ssh'), invoke });
    const delivery = new HyperVGuestFileDelivery({ identity, invoke });
    const probe = new SshAccessProbe({ invoke });
    const preparation = createLinuxAccessPreparation({ material, delivery, probe });
    return Object.freeze({
      connection: async (target) => preparation.connection(target),
      prepare: (request) => preparation.ensure(request),
    });
  }
  if (family === 'windows' && platform === 'win32' && typeof windowsAccess === 'function') {
    return Object.freeze({ connection: (target) => windowsAccess(target), prepare: null });
  }
  throw new Error(`environment guest access requires setup re-entry for ${platform}/${family}`);
}

export function createEnvironmentConstructionPreparation({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  createBootstrap = createEnvironmentBootstrap,
  createAccess = createLocalEnvironmentAccess,
  windowsAccess = null,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment preparation stateDirectory is required');
  if (typeof invoke !== 'function') throw new TypeError('environment preparation invocation contract is invalid');
  if (typeof createBootstrap !== 'function' || typeof createAccess !== 'function') throw new TypeError('environment preparation composition contract is incomplete');
  const values = new Map();

  const resolve = async (rawRequest) => {
    const request = requireObject(rawRequest, 'environment preparation request');
    const declaration = requireObject(request.declaration, 'environment preparation declaration');
    if (!sameRequirement(request.enrollment ?? declaration.enrollment, declaration.enrollment)) throw new Error('environment preparation enrollment no longer matches declaration authority');
    if (!sameBootstrap(request.bootstrap ?? declaration.bootstrap, declaration.bootstrap)) throw new Error('environment preparation bootstrap no longer matches declaration authority');
    if (declaration.enrollment?.requirement !== 'unique-guest-trust-v1') throw new Error(`unsupported environment enrollment requirement: ${String(declaration.enrollment?.requirement ?? 'missing')}`);
    const target = executionProfileSubject(declaration.profile);
    const key = JSON.stringify([declaration.profile, declaration.guest, declaration.bootstrap, declaration.enrollment]);
    if (!values.has(key)) {
      const access = await createAccess({ stateDirectory, platform, invoke, guest: declaration.guest, windowsAccess });
      if (!access || typeof access.connection !== 'function' || (access.prepare != null && typeof access.prepare !== 'function')) throw new TypeError('environment access composition contract is incomplete');
      const bootstrap = await createBootstrap({
        stateDirectory,
        platform,
        invoke,
        access: (selected) => access.connection(selected),
        prepareAccess: access.prepare == null ? null : (input) => access.prepare(input),
        requirements: declaration.bootstrap.requirements,
        revision: declaration.bootstrap.generation,
      });
      if (!bootstrap || typeof bootstrap.ensure !== 'function' || typeof bootstrap.inspect !== 'function' || typeof bootstrap.connection !== 'function') throw new TypeError('environment bootstrap composition contract is incomplete');
      values.set(key, Object.freeze({ target, access, bootstrap }));
    }
    return { request, declaration, selected: values.get(key) };
  };

  return Object.freeze({
    async ensure(request) {
      const { selected } = await resolve(request);
      const result = await selected.bootstrap.ensure(selected.target);
      if (result?.ready !== true) throw new Error(result?.reason ?? 'environment bootstrap did not become ready');
      return Object.freeze({ ready: true, implementationGeneration: request.implementationGeneration });
    },
    async inspect(request) {
      try {
        const { selected } = await resolve(request);
        const result = await selected.bootstrap.inspect(selected.target);
        return Object.freeze({
          ready: result?.ready === true,
          enrollment: result?.ready === true ? 'ready' : 'unavailable',
          bootstrap: result?.ready === true ? 'ready' : 'unavailable',
          reason: result?.ready === true ? null : String(result?.reason ?? 'environment bootstrap is unavailable').slice(0, 2048),
        });
      } catch (error) {
        return Object.freeze({ ready: false, enrollment: 'unknown', bootstrap: 'unavailable', reason: safeReason(error) });
      }
    },
    async access(request) {
      const { selected } = await resolve(request);
      return selected.access.connection(selected.target);
    },
    async connection(request, target = null) {
      const { selected } = await resolve(request);
      if (target != null && target !== selected.target) throw new Error('environment preparation connection target does not match declaration authority');
      return selected.bootstrap.connection(selected.target);
    },
  });
}
