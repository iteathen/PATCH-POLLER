import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { baseImageIdentity } from '../src/values/base-image-identity.js';
import { IMAGE_ARTIFACT_MANIFEST_PROTOCOL, imageArtifactManifestDigest } from '../src/runtime/image-artifact-manifest.js';
import { ImageArtifactAcquisition } from '../src/runtime/image-artifact-acquisition.js';

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function fixture(encodedDigest) {
  const canonical = Buffer.from('canonical');
  const encoded = Buffer.from('encoded-canonical');
  const imageDigest = sha(canonical);
  const identity = baseImageIdentity('linux-development', 'generation-v1', imageDigest);
  const manifest = { protocol: IMAGE_ARTIFACT_MANIFEST_PROTOCOL,
    image: { identity, profile: 'linux-development', generation: 'generation-v1', format: 'image', virtualSize: 4096, size: canonical.length, sha256: imageDigest, bootstrap: 'tooling-v1' },
    encoding: { algorithm: 'test', parameters: { version: '1' }, size: encoded.length, sha256: encodedDigest },
    chunks: [{ ordinal: 0, name: 'part-000', offset: 0, size: encoded.length, sha256: sha(encoded) }] };
  return { canonical, encoded, manifest };
}

test('whole encoded-object digest is authoritative even when every chunk verifies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-whole-digest-'));
  try {
    const value = fixture('0'.repeat(64));
    const source = { manifest: async () => ({ manifest: value.manifest, digest: imageArtifactManifestDigest(value.manifest) }), fetch: async ({ destination }) => writeFile(destination, value.encoded) };
    const local = { verify: async () => ({ exists: false, usable: false, verified: false, entry: null }), publish: async () => { throw new Error('must not publish'); } };
    const codec = { algorithm: 'test', decode: async () => { throw new Error('must not decode'); } };
    await assert.rejects(() => new ImageArtifactAcquisition({ directory: path.join(root, 'recovery'), local, source, codec }).ensure({ identity: value.manifest.image.identity }), /complete encoded image failed verification/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale manifest digest fails before transport', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-stale-manifest-'));
  try {
    const value = fixture(sha(Buffer.from('encoded-canonical')));
    let fetched = false;
    const source = { manifest: async () => ({ manifest: value.manifest, digest: '0'.repeat(64) }), fetch: async () => { fetched = true; } };
    const local = { verify: async () => ({ exists: false, usable: false, verified: false, entry: null }), publish: async () => {} };
    await assert.rejects(() => new ImageArtifactAcquisition({ directory: path.join(root, 'recovery'), local, source, codec: { algorithm: 'test', decode: async () => {} } }).ensure({ identity: value.manifest.image.identity }), /manifest digest/u);
    assert.equal(fetched, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
