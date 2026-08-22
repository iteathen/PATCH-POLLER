import path from 'node:path';
import { pauseDaemon, resumeDaemon } from '../runtime/daemon-lock.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createEnvironmentLifecycleFence({
  stateDirectory,
  pause = pauseDaemon,
  resume = resumeDaemon,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment lifecycle fence stateDirectory is required');
  if (typeof pause !== 'function' || typeof resume !== 'function') throw new TypeError('environment lifecycle fence governance contract is incomplete');
  const lockPath = path.join(path.resolve(stateDirectory), 'daemon.lock');

  return Object.freeze({
    async acquire({ environmentIdentity, operationId }) {
      const subject = safeId(environmentIdentity, 'environment lifecycle fence environmentIdentity');
      safeId(operationId, 'environment lifecycle fence operationId');
      const status = await pause(lockPath);
      if (status?.activeLock === true && status.paused !== true) {
        throw new Error('environment lifecycle fence could not reach the daemon safe boundary');
      }
      const ownsPause = status?.activeLock === true
        && status.requested === true
        && status.alreadyRequested !== true;
      let released = false;
      return Object.freeze({
        subject,
        async release() {
          if (released) return;
          released = true;
          if (!ownsPause) return;
          const result = await resume(lockPath);
          if (result?.resumed !== true) throw new Error('environment lifecycle fence could not resume daemon admission');
        },
      });
    },
  });
}
