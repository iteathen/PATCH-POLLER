import { createHash } from 'node:crypto';

function reference(identity, namespace, value = '') {
  return `db-${namespace}-${createHash('sha256').update(`${identity}:${namespace === 'env' ? 'persistent' : 'network'}:${value}`).digest('hex').slice(0, 16)}`;
}
function uuid(identity, target) {
  const hex = createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function createLibvirtEnvironmentLocation(identity) {
  if (typeof identity !== 'string' || !/^[a-f0-9]{32}$/u.test(identity)) throw new TypeError('provider location identity is invalid');
  return Object.freeze({
    environment(target) {
      if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) throw new TypeError('provider environment target is invalid');
      return Object.freeze({
        reference: reference(identity, 'env', target),
        proof: `devbridge-owned:${identity}:persistent:${target}:v1`,
        identity: uuid(identity, target),
      });
    },
    network() {
      return Object.freeze({
        reference: reference(identity, 'network'),
        proof: `devbridge-owned:${identity}:network:v1`,
      });
    },
  });
}
