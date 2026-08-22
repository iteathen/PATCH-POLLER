import { createImageArtifactCapacity } from '../runtime/image-artifact-capacity.js';
import { ImageArtifactAcquisition } from '../runtime/image-artifact-acquisition.js';
import { createRecoverableImageCache } from './recoverable-image-cache.js';

export function createImageAvailability({ recoveryDirectory, quarantineDirectory, library, source, codec, capacity = null } = {}) {
  const local = createRecoverableImageCache({ library, quarantineDirectory });
  const storage = capacity ?? createImageArtifactCapacity({ directory: recoveryDirectory });
  const acquisition = new ImageArtifactAcquisition({ directory: recoveryDirectory, local, source, codec, capacity: storage });
  return Object.freeze({ ensure: (request) => acquisition.ensure(request) });
}
