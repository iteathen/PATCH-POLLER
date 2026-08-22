import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentImageCache } from '../src/app/environment-image-cache.js';

test('environment image cache exposes only neutral image-library studs', async () => {
  const calls = [];
  const state = {
    observeImage: async (identity) => { calls.push(['observe', identity]); return { identity }; },
    verifyImage: async (identity) => { calls.push(['verify', identity]); return { identity, verified: true }; },
    publishImage: async (input) => { calls.push(['publish', input]); return { identity: input.identity ?? 'created' }; },
    listImages: async () => { calls.push(['list']); return []; },
    retireImage: async (identity) => { calls.push(['retire', identity]); return { identity }; },
    collectImages: async (options) => { calls.push(['collect', options]); return { removed: [] }; },
  };
  const cache = createEnvironmentImageCache({ state });
  await cache.observe('img-1');
  await cache.verify('img-1');
  await cache.publish({ identity: 'img-1' });
  await cache.list();
  await cache.retire('img-1');
  await cache.collect({ protectedIdentities: ['img-2'] });
  assert.deepEqual(calls.map(([name]) => name), ['observe', 'verify', 'publish', 'list', 'retire', 'collect']);
});
