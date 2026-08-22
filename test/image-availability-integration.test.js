import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BaseImageLibrary } from '../src/runtime/base-image-library.js';
import { buildImageArtifactBundle } from '../src/runtime/image-artifact-bundle.js';
import { createImageAvailability } from '../src/app/image-availability.js';

const codec = {
  algorithm: 'test-frame',
  async describe() { return { algorithm: 'test-frame', parameters: { version: '1' } }; },
  async encode({ source, destination }) { await writeFile(destination, Buffer.concat([Buffer.from('F:'), await readFile(source)])); },
  async decode({ source, destination }) { const bytes = await readFile(source); await writeFile(destination, bytes.subarray(2)); },
};

test('availability reconstructs and repairs the real immutable local image cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-real-cache-'));
  try {
    const canonical = path.join(root, 'canonical.img');
    const bundle = path.join(root, 'bundle');
    await writeFile(canonical, 'canonical-image-for-real-cache-integration');
    const built = await buildImageArtifactBundle({ canonical, destination: bundle, profile: 'linux-development', generation: 'integration-v1', format: 'image', virtualSize: 4096, bootstrap: 'tooling-v1', codec, chunkBytes: 7 });
    const library = new BaseImageLibrary({ directory: path.join(root, 'library') });
    const source = {
      async manifest() { return { manifest: built.manifest, digest: built.manifestDigest }; },
      async fetch({ name, destination }) { await copyFile(path.join(bundle, name), destination); },
    };
    const availability = createImageAvailability({ recoveryDirectory: path.join(root, 'recovery'), quarantineDirectory: path.join(root, 'quarantine'), library, source, codec, capacity: { ensure: async () => ({ ready: true }) } });
    const validate = async () => ({ usable: true, format: 'image', parentIdentity: null, virtualSize: 4096 });

    const first = await availability.ensure({ identity: built.manifest.image.identity, generation: built.manifest.image.generation, validate });
    assert.equal(first.state, 'reconstructed');
    assert.equal((await library.verify(built.manifest.image.identity)).verified, true);

    const observed = await library.observe(built.manifest.image.identity);
    await chmod(observed.location, 0o600);
    await writeFile(observed.location, 'corrupt-local-cache');
    assert.notEqual((await library.verify(built.manifest.image.identity)).verified, true);

    const repaired = await availability.ensure({ identity: built.manifest.image.identity, generation: built.manifest.image.generation, validate });
    assert.equal(repaired.state, 'reconstructed');
    assert.equal((await library.verify(built.manifest.image.identity)).verified, true);
    assert.equal((await readdir(path.join(root, 'quarantine'))).some((name) => name.endsWith('.quarantine')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
