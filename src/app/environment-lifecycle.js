import path from 'node:path';
import { EnvironmentDeclarationRegistry } from '../runtime/environment-declaration.js';
import { EnvironmentLifecycleJournal } from '../runtime/environment-lifecycle-journal.js';
import { createEnvironmentLifecycleStateStore } from '../state/environment-lifecycle-state-store.js';

export function createEnvironmentLifecycle({ stateDirectory, now, operationId } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment lifecycle state directory is required');
  const port = createEnvironmentLifecycleStateStore(path.join(path.resolve(stateDirectory), 'environment-lifecycle', 'state.json'));
  return Object.freeze({
    declarations: new EnvironmentDeclarationRegistry({ port: port.declarations, ...(now ? { now } : {}) }),
    journal: new EnvironmentLifecycleJournal({ port: port.journal, ...(now ? { now } : {}), ...(operationId ? { id: operationId } : {}) }),
  });
}
