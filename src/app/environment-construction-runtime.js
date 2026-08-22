import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentConstruction } from './environment-construction.js';
import { createEnvironmentConstructionObservation } from './environment-construction-observation.js';
import {
  createEnvironmentImagePort,
  createEnvironmentResourcePort,
} from './environment-construction-ports.js';
import { createEnvironmentConstructionPreparation } from './environment-construction-preparation.js';
import { createEnvironmentConstructionWorkspaces } from './environment-construction-workspaces.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentImageAvailability } from './environment-image-availability.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { createEnvironmentLifecycleFence } from './environment-lifecycle-fence.js';
import { createEnvironmentMaterialization } from './environment-materialization.js';
import { createEnvironmentMaterializationPolicy } from './environment-materialization-policy.js';
import { invokeCommand } from '../runtime/command-invocation.js';

function assertAvailability(value) {
  if (!value || typeof value.ensure !== 'function') throw new TypeError('environment construction image availability contract is incomplete');
  return value;
}

export async function createEnvironmentConstructionRuntime({
  stateDirectory,
  availability = null,
  source = null,
  codec = null,
  capacity = null,
  resolveAuthority,
  platform = process.platform,
  invoke = invokeCommand,
  foundation = null,
  lifecycle = null,
  fence = null,
  windowsAccess = null,
  now,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment construction runtime stateDirectory is required');
  if (typeof resolveAuthority !== 'function') throw new TypeError('environment construction runtime authority resolver is required');
  if (typeof invoke !== 'function') throw new TypeError('environment construction runtime invocation contract is invalid');

  const localFoundation = foundation ?? await createEnvironmentFoundation({ stateDirectory, platform, invoke });
  const localAvailability = availability == null
    ? createEnvironmentImageAvailability({ stateDirectory, foundation: localFoundation, source, codec, capacity })
    : assertAvailability(availability);
  const localLifecycle = lifecycle ?? createEnvironmentLifecycle({ stateDirectory, ...(now ? { now } : {}) });
  const policy = createEnvironmentMaterializationPolicy();
  const materialization = createEnvironmentMaterialization({
    state: localFoundation,
    subject: policy.subject,
    settings: policy.settings,
  });
  const preparation = createEnvironmentConstructionPreparation({
    stateDirectory,
    platform,
    invoke,
    windowsAccess,
  });
  const workspaces = createEnvironmentConstructionWorkspaces({
    stateDirectory,
    state: localFoundation,
    resolveAuthority,
    resolveAccess: ({ declaration }) => preparation.access({ declaration }),
    resolveChannel: async ({ declaration }) => createEnvironmentBridge({
      stateDirectory,
      platform,
      invoke,
      access: (target) => preparation.connection({ declaration }, target),
    }),
  });
  const observation = createEnvironmentConstructionObservation({ materialization, preparation, workspaces });
  const localFence = fence ?? createEnvironmentLifecycleFence({ stateDirectory });
  const construction = createEnvironmentConstruction({
    stateDirectory,
    lifecycle: localLifecycle,
    observer: observation,
    fence: localFence,
    image: createEnvironmentImagePort({ availability: localAvailability }),
    resources: createEnvironmentResourcePort({ state: localFoundation, settings: policy.settings }),
    materialization,
    preparation,
    workspaces,
    readiness: observation.readiness,
    ...(now ? { now } : {}),
  });

  return Object.freeze({
    lifecycle: localLifecycle,
    foundation: localFoundation,
    observer: observation,
    create: construction.create,
    pipeline: construction.pipeline,
  });
}
