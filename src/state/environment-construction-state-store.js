import { JsonStateStore } from './json-state-store.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
function key(value) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError('environment construction operation identity is invalid'); return `construction:${value}`; }

export function createEnvironmentConstructionStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('environment construction state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (operationId) => store.get(key(operationId)),
    save: (operationId, value) => store.set(key(operationId), value),
    delete: (operationId) => store.delete(key(operationId)),
    async scan() { return (await store.entries('construction:')).map(([, value]) => value); },
  });
}
