import { createHash } from 'node:crypto';

function reference(identity, namespace, value = '') {
  return `db-${namespace}-${createHash('sha256').update(`${identity}:${namespace === 'env' ? 'persistent' : 'network'}:${value}`).digest('hex').slice(0, 16)}`;
}

export function createHyperVEnvironmentLocation(identity) {
  if (typeof identity !== 'string' || !/^[a-f0-9]{32}$/u.test(identity)) throw new TypeError('provider location identity is invalid');
  const digest = createHash('sha256').update(`${identity}:network`).digest();
  const third = 64 + (digest[0] % 128);
  return Object.freeze({
    environment(target) {
      if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) throw new TypeError('provider environment target is invalid');
      return Object.freeze({
        reference: reference(identity, 'env', target),
        proof: `devbridge-owned:${identity}:persistent:${target}:v1`,
      });
    },
    network() {
      return Object.freeze({
        reference: reference(identity, 'network'),
        proof: `devbridge-owned:${identity}:network:default:v1`,
        prefix: `192.168.${third}.0/24`,
        gateway: `192.168.${third}.1`,
      });
    },
  });
}
