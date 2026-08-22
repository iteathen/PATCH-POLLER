import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageRetention } from '../src/app/image-retention.js';
const one = `img-${'1'.repeat(32)}`; const two = `img-${'2'.repeat(32)}`;
test('retention protects every image referenced by durable declarations', async () => { let observed = null; const retention = createImageRetention({ declarations: { list: async () => [{ declaration: { image: { identity: two } } }, { declaration: { image: { identity: one } } }, { declaration: { image: { identity: two } } }] }, cache: { collect: async (input) => { observed = input; return { removed: ['other'] }; } } }); const result = await retention.collect(); assert.deepEqual(observed, { protectedIdentities: [one, two] }); assert.deepEqual(result.protectedIdentities, [one, two]); });
