const PROTOCOL = 'devbridge/environment-foundation-status-v1';
const SAFE_IDENTITY = /^[a-f0-9]{32}$/u;
const SAFE_INSTANCE = /^[a-f0-9]{32,64}$/u;
const SAFE_ENVIRONMENT = /^env-[a-f0-9]{32}$/u;
const STATES = new Set(['ready', 'degraded', 'unavailable']);

function capability(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} capability must be an object`);
  if (!STATES.has(raw.state) || typeof raw.ready !== 'boolean' || (raw.state === 'ready') !== raw.ready) {
    throw new TypeError(`${name} capability state is invalid`);
  }
  const reason = raw.reason == null ? null : String(raw.reason);
  if (!raw.ready && !reason) throw new TypeError(`${name} capability requires a reason when unready`);
  return Object.freeze({ state: raw.state, ready: raw.ready, reason });
}

function controlStatus(raw, identity) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('environment control status must be an object');
  if (raw.identity !== identity) throw new TypeError('environment control status identity changed');
  return {
    identity,
    management: capability(raw.capabilities?.management, 'management'),
    networking: capability(raw.capabilities?.networking, 'networking'),
    storage: capability(raw.capabilities?.storage, 'storage'),
  };
}

function foundationStatus(identity, management, images, networking, storage) {
  const ready = management.ready && images.ready && networking.ready && storage.ready;
  const anyReady = management.ready || images.ready || networking.ready || storage.ready;
  const state = ready ? 'ready' : anyReady ? 'degraded' : 'unavailable';
  const reasons = [management, images, networking, storage].filter((entry) => !entry.ready).map((entry) => entry.reason).filter(Boolean);
  return Object.freeze({
    protocol: PROTOCOL,
    state,
    ready,
    identity,
    reason: ready ? null : reasons.join('; '),
    capabilities: Object.freeze({ management, images, networking, storage }),
  });
}

export function normalizeEnvironmentFoundationStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('environment foundation status must be an object');
  const allowed = new Set(['protocol', 'state', 'ready', 'identity', 'reason', 'capabilities']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`environment foundation status.${key} is not allowed`);
  if (raw.protocol !== PROTOCOL || !STATES.has(raw.state) || typeof raw.ready !== 'boolean' || (raw.state === 'ready') !== raw.ready) {
    throw new TypeError('environment foundation status is invalid');
  }
  if (typeof raw.identity !== 'string' || !SAFE_IDENTITY.test(raw.identity)) throw new TypeError('environment foundation status identity is invalid');
  const management = capability(raw.capabilities?.management, 'management');
  const images = capability(raw.capabilities?.images, 'images');
  const networking = capability(raw.capabilities?.networking, 'networking');
  const storage = capability(raw.capabilities?.storage, 'storage');
  const normalized = foundationStatus(raw.identity, management, images, networking, storage);
  if (normalized.state !== raw.state || normalized.ready !== raw.ready) throw new TypeError('environment foundation aggregate state is inconsistent');
  return normalized;
}

export function assertEnvironmentFoundationContract(value) {
  const methods = ['inspect', 'publishImage', 'listImages', 'verifyImage', 'retireImage', 'collectImages', 'ensureNetwork', 'releaseNetwork', 'ensureStorage', 'releaseStorage', 'reconcile', 'observeInstance', 'startInstance', 'stopInstance', 'removeInstance'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment foundation contract is incomplete');
  return value;
}

function requireInstanceIdentity(value) {
  if (typeof value !== 'string' || !SAFE_INSTANCE.test(value)) throw new TypeError('instance identity must be an opaque local token');
  return value;
}

function requireEnvironmentIdentity(value) {
  if (typeof value !== 'string' || !SAFE_ENVIRONMENT.test(value)) throw new TypeError('persistent environment identity is invalid');
  return value;
}

function mediaObservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { usable: false, reason: 'image media observation is invalid', format: null, contentIdentity: null, parentIdentity: null, virtualSize: null };
  const usable = raw.usable === true;
  return {
    usable,
    reason: usable ? null : String(raw.reason ?? 'image media is unusable'),
    format: typeof raw.format === 'string' ? raw.format : null,
    contentIdentity: raw.contentIdentity == null ? null : String(raw.contentIdentity),
    parentIdentity: raw.parentIdentity == null ? null : String(raw.parentIdentity),
    virtualSize: Number.isSafeInteger(Number(raw.virtualSize)) ? Number(raw.virtualSize) : null,
  };
}

function instanceObservation(identity, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('instance observation is invalid');
  return {
    identity,
    exists: raw.exists === true,
    owned: raw.owned === true,
    state: typeof raw.state === 'string' ? raw.state : 'unknown',
  };
}

function removalObservation(identity, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('instance removal result is invalid');
  return { identity, removed: raw.removed === true, absent: raw.absent === true };
}

function assertControl(value) {
  const methods = ['inspect', 'inspectImage', 'ensureNetwork', 'releaseNetwork', 'ensureStorage', 'releaseStorage', 'reconcile', 'observeInstance', 'startInstance', 'stopInstance', 'removeInstance'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment control contract is incomplete');
  return value;
}

function assertImages(value) {
  const methods = ['publish', 'list', 'observe', 'verify', 'inspect', 'retire', 'collect', 'reconcile'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('image library contract is incomplete');
  return value;
}

function unavailableLifecycle() {
  const reason = 'persistent environments are unavailable';
  return {
    async ensure() { throw new Error(reason); },
    async list() { return []; },
    async observe() { throw new Error(reason); },
    async start() { throw new Error(reason); },
    async stop() { throw new Error(reason); },
    async reset() { throw new Error(reason); },
    async reseed() { throw new Error(reason); },
    async remove() { throw new Error(reason); },
    async reconcile() { return []; },
    async protectedSourceIdentities() { return []; },
  };
}

function assertLifecycle(value) {
  const methods = ['ensure', 'list', 'observe', 'start', 'stop', 'reset', 'reseed', 'remove', 'reconcile', 'protectedSourceIdentities'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('persistent environment lifecycle contract is incomplete');
  return value;
}

function imageCapability(raw) {
  return capability(raw, 'images');
}

export class EnvironmentFoundation {
  #identity;
  #control;
  #images;
  #lifecycle;

  constructor({ identity, control, images, lifecycle = null }) {
    if (typeof identity !== 'string' || !SAFE_IDENTITY.test(identity)) throw new TypeError('environment foundation identity is invalid');
    this.#identity = identity;
    this.#control = assertControl(control);
    this.#images = assertImages(images);
    this.#lifecycle = assertLifecycle(lifecycle ?? unavailableLifecycle());
  }

  async inspect() {
    const control = controlStatus(await this.#control.inspect(), this.#identity);
    let images = imageCapability(await this.#images.inspect());
    if (images.ready && !control.management.ready) {
      images = capability({ state: 'degraded', ready: false, reason: 'image media cannot be observed while management is unavailable' }, 'images');
    } else if (images.ready && control.management.ready) {
      const entries = (await this.#images.list()).filter((entry) => entry.retiredAt == null);
      for (const entry of entries) {
        const observed = await this.#images.observe(entry.identity);
        if (!observed.usable) {
          images = capability({ state: 'degraded', ready: false, reason: observed.reason }, 'images');
          break;
        }
        const media = mediaObservation(await this.#control.inspectImage({ location: observed.location }));
        if (!media?.usable || media.parentIdentity != null || media.format !== entry.media.format || Number(media.virtualSize) !== Number(entry.media.virtualSize)) {
          images = capability({ state: 'degraded', ready: false, reason: 'published image media no longer matches its recorded base identity' }, 'images');
          break;
        }
      }
    }
    return foundationStatus(this.#identity, control.management, images, control.networking, control.storage);
  }

  async publishImage(input) {
    const status = controlStatus(await this.#control.inspect(), this.#identity);
    if (!status.management.ready) throw new Error('environment management is unavailable');
    return this.#images.publish(input, {
      validate: async ({ location }) => mediaObservation(await this.#control.inspectImage({ location })),
    });
  }

  async listImages() { return this.#images.list(); }
  async observeImage(identity) { return this.#images.observe(identity); }

  async verifyImage(identity) {
    const observed = await this.#images.verify(identity);
    if (!observed.usable) return observed;
    const media = mediaObservation(await this.#control.inspectImage({ location: observed.location }));
    if (!media.usable || media.parentIdentity != null) return { identity, usable: false, verified: observed.verified === true, reason: 'image media validation failed', media: null };
    return { identity, usable: true, verified: observed.verified === true, reason: null, media };
  }

  async retireImage(identity) { return this.#images.retire(identity); }

  async collectImages(options = {}) {
    const requested = Array.isArray(options?.protectedIdentities) ? options.protectedIdentities : [];
    const protectedIdentities = [...new Set([...requested, ...await this.#lifecycle.protectedSourceIdentities()])];
    return this.#images.collect({ ...options, protectedIdentities });
  }

  async ensureNetwork() {
    await this.#control.ensureNetwork();
    const status = controlStatus(await this.#control.inspect(), this.#identity);
    return status.networking;
  }

  async releaseNetwork() {
    const result = await this.#control.releaseNetwork();
    return { changed: result?.released === true };
  }

  async ensureStorage() {
    await this.#control.ensureStorage();
    const status = controlStatus(await this.#control.inspect(), this.#identity);
    return status.storage;
  }

  async releaseStorage() {
    const result = await this.#control.releaseStorage();
    return { changed: result?.released === true };
  }

  async ensureEnvironment(input) { return this.#lifecycle.ensure(input); }
  async listEnvironments() { return this.#lifecycle.list(); }
  async observeEnvironment(identity) { return this.#lifecycle.observe(requireEnvironmentIdentity(identity)); }
  async startEnvironment(identity) { return this.#lifecycle.start(requireEnvironmentIdentity(identity)); }
  async stopEnvironment(identity, options = {}) { return this.#lifecycle.stop(requireEnvironmentIdentity(identity), options); }
  async resetEnvironment(identity) { return this.#lifecycle.reset(requireEnvironmentIdentity(identity)); }
  async reseedEnvironment(identity, options) { return this.#lifecycle.reseed(requireEnvironmentIdentity(identity), options); }
  async removeEnvironment(identity) { return this.#lifecycle.remove(requireEnvironmentIdentity(identity)); }

  async reconcile() {
    await this.#images.reconcile();
    await this.#control.reconcile();
    await this.#lifecycle.reconcile();
    return this.inspect();
  }

  async observeInstance(identity) {
    const local = requireInstanceIdentity(identity);
    return instanceObservation(local, await this.#control.observeInstance(local));
  }

  async startInstance(identity) {
    const local = requireInstanceIdentity(identity);
    return instanceObservation(local, await this.#control.startInstance(local));
  }

  async stopInstance(identity, options = {}) {
    const local = requireInstanceIdentity(identity);
    return instanceObservation(local, await this.#control.stopInstance(local, options));
  }

  async removeInstance(identity) {
    const local = requireInstanceIdentity(identity);
    return removalObservation(local, await this.#control.removeInstance(local));
  }
}

export class UnavailableEnvironmentControl {
  #identity;
  #reason;
  constructor({ identity, reason = 'environment management is unavailable' }) {
    if (typeof identity !== 'string' || !SAFE_IDENTITY.test(identity)) throw new TypeError('environment control identity is invalid');
    this.#identity = identity;
    this.#reason = String(reason);
  }
  async inspect() {
    const entry = { state: 'unavailable', ready: false, reason: this.#reason };
    return { identity: this.#identity, capabilities: { management: entry, networking: entry, storage: entry } };
  }
  async inspectImage() { return { usable: false, reason: this.#reason, format: 'image', contentIdentity: null, parentIdentity: null, virtualSize: 1 }; }
  async ensureNetwork() { throw new Error(this.#reason); }
  async releaseNetwork() { return { released: false, reason: this.#reason }; }
  async ensureStorage() { throw new Error(this.#reason); }
  async releaseStorage() { return { released: false, reason: this.#reason }; }
  async reconcile() { return this.inspect(); }
  async observeInstance(identity) { return { identity, exists: false, owned: false, state: 'unavailable', reason: this.#reason }; }
  async startInstance() { throw new Error(this.#reason); }
  async stopInstance() { throw new Error(this.#reason); }
  async removeInstance() { throw new Error(this.#reason); }
}

export { PROTOCOL as ENVIRONMENT_FOUNDATION_STATUS_PROTOCOL };
