import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BaseImageLibrary } from '../src/runtime/base-image-library.js';
import { baseImageIdentity } from '../src/values/base-image-identity.js';
import { createHash } from 'node:crypto';
test('artifact semantic identity matches BaseImageLibrary publication identity', async () => { const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-identity-')); try { const source = path.join(root, 'source.img'); const bytes = Buffer.from('identity-compatibility-canonical-image'); await writeFile(source, bytes); const sha256 = createHash('sha256').update(bytes).digest('hex'); const library = new BaseImageLibrary({ directory: path.join(root, 'library') }); const entry = await library.publish({ profile: 'linux-development', generation: 'compatibility-v1', source, expectedDigest: sha256, provenance: { origin: 'identity-compatibility-test' } }); assert.equal(entry.identity, baseImageIdentity('linux-development', 'compatibility-v1', sha256)); } finally { await rm(root, { recursive: true, force: true }); } });
