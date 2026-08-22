import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildImageArtifactBundle } from '../src/runtime/image-artifact-bundle.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-image-bundle-')); }
function framedCodec(events) { return { async describe() { return { algorithm: 'test-frame', parameters: { version: '1' } }; }, async encode({ source, destination }) { events.push('encode-start'); const bytes = await readFile(source); await writeFile(destination, Buffer.concat([Buffer.from('ENC['), bytes, Buffer.from(']END')])); events.push('encode-complete'); } }; }

test('bundle encodes one whole canonical stream before transport chunking', async () => {
  const parent = await root();
  try { const canonical = path.join(parent, 'base.vhdx'); const destination = path.join(parent, 'bundle'); const content = Buffer.from('0123456789abcdef'); await writeFile(canonical, content); const events = [];
    const result = await buildImageArtifactBundle({ canonical, destination, profile: 'linux-development', generation: 'ubuntu-v1', format: 'vhdx', virtualSize: 4096, bootstrap: 'tooling-v1', codec: framedCodec(events), chunkBytes: 7 });
    assert.deepEqual(events, ['encode-start', 'encode-complete']); assert.ok(result.manifest.chunks.length > 1);
    const chunkBytes = await Promise.all(result.chunkNames.map((name) => readFile(path.join(destination, name))));
    assert.deepEqual(Buffer.concat(chunkBytes), Buffer.concat([Buffer.from('ENC['), content, Buffer.from(']END')]));
    assert.equal((await readdir(destination)).some((name) => name.startsWith('.encoded-')), false); assert.match(result.manifestDigest, /^[a-f0-9]{64}$/u);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
test('bundle refuses a pre-existing destination rather than cleaning caller data', async () => {
  const parent = await root();
  try { const canonical = path.join(parent, 'base.img'); const destination = path.join(parent, 'bundle'); await writeFile(canonical, 'canonical'); await writeFile(destination, 'caller-owned');
    await assert.rejects(() => buildImageArtifactBundle({ canonical, destination, profile: 'p', generation: 'g', format: 'img', virtualSize: 9, bootstrap: 'b', codec: framedCodec([]), chunkBytes: 4 }), /already exists/u);
    assert.equal(await readFile(destination, 'utf8'), 'caller-owned');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
