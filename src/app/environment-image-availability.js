import path from 'node:path';
import { createImageAvailability } from './image-availability.js';

function assertFoundation(value) {
  const methods = ['publishImage', 'observeImage', 'verifyImage', 'listImages', 'retireImage', 'collectImages'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment image foundation contract is incomplete');
  return value;
}

function assertSource(value) {
  if (!value || typeof value.manifest !== 'function' || typeof value.fetch !== 'function') throw new TypeError('environment image source contract is incomplete');
  return value;
}

function assertCodec(value) {
  if (!value || typeof value.decode !== 'function') throw new TypeError('environment image codec contract is incomplete');
  return value;
}

export function createEnvironmentImageLibraryPort({ foundation } = {}) {
  const local = assertFoundation(foundation);
  return Object.freeze({
    async verify(identity) {
      const verified = await local.verifyImage(identity);
      const observed = await local.observeImage(identity);
      return Object.freeze({
        ...observed,
        usable: verified?.usable === true && observed?.usable === true,
        verified: verified?.verified === true,
        reason: verified?.usable === true && observed?.usable === true ? null : String(verified?.reason ?? observed?.reason ?? 'image verification failed'),
        media: verified?.media ?? null,
      });
    },
    publish(input) {
      return local.publishImage(input);
    },
    observe(identity) {
      return local.observeImage(identity);
    },
    list() {
      return local.listImages();
    },
    retire(identity) {
      return local.retireImage(identity);
    },
    collect(options) {
      return local.collectImages(options);
    },
  });
}

export function createEnvironmentImageAvailability({
  stateDirectory,
  foundation,
  source,
  codec,
  capacity = null,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment image availability stateDirectory is required');
  const root = path.join(path.resolve(stateDirectory), 'environment-foundation', 'image-recovery');
  return createImageAvailability({
    recoveryDirectory: path.join(root, 'transfer'),
    quarantineDirectory: path.join(root, 'quarantine'),
    library: createEnvironmentImageLibraryPort({ foundation }),
    source: assertSource(source),
    codec: assertCodec(codec),
    capacity,
  });
}
