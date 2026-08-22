import test from 'node:test';
import assert from 'node:assert/strict';
import { imageArtifactCapacityRequirement, createImageArtifactCapacity } from '../src/runtime/image-artifact-capacity.js';

test('capacity requirement includes missing chunks, assembly, admission, quarantine, and headroom', () => {
  assert.equal(imageArtifactCapacityRequirement({ downloadBytes: 10, encodedBytes: 20, canonicalBytes: 30, replacementBytes: 30 }), 10 + 20 + 30 + 30 + 30 + 64 * 1024 * 1024);
});
test('capacity fails before transfer when available storage is insufficient', async () => {
  const capacity = createImageArtifactCapacity({ directory: process.cwd(), inspect: async () => ({ bsize: 1n, bavail: 100n }) });
  await assert.rejects(() => capacity.ensure({ downloadBytes: 1, encodedBytes: 1, canonicalBytes: 1 }), /insufficient image recovery storage/u);
});
