import path from 'node:path';
import { EnvironmentConstructionPipeline } from '../runtime/environment-construction.js';
import { EnvironmentCreate } from '../runtime/environment-create.js';
import { createEnvironmentConstructionStateStore } from '../state/environment-construction-state-store.js';

export function createEnvironmentConstruction({ stateDirectory, lifecycle, observer, fence, image, resources, materialization, preparation, workspaces, readiness, now } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment construction state directory is required');
  if (!lifecycle || !lifecycle.declarations || !lifecycle.journal) throw new TypeError('environment construction lifecycle contract is incomplete');
  const checkpoint = createEnvironmentConstructionStateStore(path.join(path.resolve(stateDirectory), 'environment-construction', 'state.json'));
  const pipeline = new EnvironmentConstructionPipeline({ checkpoint, image, resources, materialization, preparation, workspaces, readiness, ...(now ? { now } : {}) });
  const creation = new EnvironmentCreate({ declarations: lifecycle.declarations, journal: lifecycle.journal, observer, fence, construction: pipeline });
  return Object.freeze({ pipeline, create: (identity) => creation.create(identity) });
}
