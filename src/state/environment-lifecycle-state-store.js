import { JsonStateStore } from './json-state-store.js';

function prefixedPort(store, prefix) {
  return Object.freeze({
    load: (identity) => store.get(`${prefix}:${identity}`),
    save: (identity, value) => store.set(`${prefix}:${identity}`, value),
    async scan() {
      return (await store.entries(`${prefix}:`)).map(([, value]) => value);
    },
  });
}

export function createEnvironmentLifecycleStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('environment lifecycle state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    declarations: prefixedPort(store, 'declaration'),
    journal: prefixedPort(store, 'journal'),
  });
}
