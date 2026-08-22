import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentImageLibraryPort } from '../src/app/environment-image-availability.js';

test('environment image cache admission delegates publication to provider-validating foundation authority', async () => {
  const events = [];
  const foundation = {
    publishImage: async (input) => { events.push(['publish', input]); return { identity: 'img-0123456789abcdef0123456789abcdef' }; },
    observeImage: async (identity) => ({ exists: true, usable: true, identity, location: '/owned/image', entry: { generation: 'generation-v1' } }),
    verifyImage: async (identity) => ({ identity, usable: true, verified: true, media: { format: 'vhdx', virtualSize: 4096 } }),
    listImages: async () => [],
    retireImage: async (identity) => { events.push(['retire', identity]); return { changed: true }; },
    collectImages: async (options) => { events.push(['collect', options]); return { removed: [] }; },
  };
  const port = createEnvironmentImageLibraryPort({ foundation });
  const verified = await port.verify('img-0123456789abcdef0123456789abcdef');
  assert.equal(verified.verified, true);
  assert.equal(verified.entry.generation, 'generation-v1');
  const input = { profile: 'linux-development', generation: 'generation-v1', source: '/temporary/canonical' };
  await port.publish(input, { validate: async () => { throw new Error('generic validation must not replace provider admission'); } });
  assert.deepEqual(events[0], ['publish', input]);
});
