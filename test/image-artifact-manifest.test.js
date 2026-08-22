import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { baseImageIdentity } from '../src/values/base-image-identity.js';
import { IMAGE_ARTIFACT_MANIFEST_PROTOCOL, imageArtifactManifestDigest, normalizeImageArtifactManifest, serializeImageArtifactManifest } from '../src/runtime/image-artifact-manifest.js';

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function manifest() {
  const imageSha = digest('canonical');
  const identity = baseImageIdentity('linux-development', 'ubuntu-24.04.4-v1', imageSha);
  const first = Buffer.from('abc'); const second = Buffer.from('de'); const encoded = Buffer.concat([first, second]);
  return { protocol: IMAGE_ARTIFACT_MANIFEST_PROTOCOL,
    image: { identity, profile: 'linux-development', generation: 'ubuntu-24.04.4-v1', format: 'vhdx', virtualSize: 1024, size: 9, sha256: imageSha, bootstrap: 'tooling-v1' },
    encoding: { algorithm: 'zstd', parameters: { version: '1', level: '9' }, size: encoded.length, sha256: digest(encoded) },
    chunks: [
      { ordinal: 0, name: 'part-000', offset: 0, size: first.length, sha256: digest(first) },
      { ordinal: 1, name: 'part-001', offset: first.length, size: second.length, sha256: digest(second) },
    ] };
}

test('base image identity remains compatible with the existing image library', () => {
  assert.equal(baseImageIdentity('linux-development', 'ubuntu-24.04.4-node-24.19.0-fast-v1', '8556390b568cf68017b3eec8a4c6f81129a84e0aeb981a41020560165fffa556'), 'img-5b9a64425927520270f743c8090f0171');
});
test('manifest canonical serialization and digest are deterministic', () => {
  const value = manifest(); const one = serializeImageArtifactManifest(value); const two = serializeImageArtifactManifest({ ...value, encoding: { ...value.encoding, parameters: { level: '9', version: '1' } } });
  assert.equal(one, two); assert.equal(imageArtifactManifestDigest(value), digest(one));
});
test('manifest rejects wrong semantic image identity', () => {
  assert.throws(() => normalizeImageArtifactManifest({ ...manifest(), image: { ...manifest().image, identity: `img-${'0'.repeat(32)}` } }), /semantic image subject/u);
});
test('manifest rejects chunk reordering, gaps, overlap, duplicate names, and incomplete coverage', () => {
  const value = manifest();
  assert.throws(() => normalizeImageArtifactManifest({ ...value, chunks: [value.chunks[1], value.chunks[0]] }), /ordinals/u);
  assert.throws(() => normalizeImageArtifactManifest({ ...value, chunks: [value.chunks[0], { ...value.chunks[1], offset: 4 }] }), /contiguous/u);
  assert.throws(() => normalizeImageArtifactManifest({ ...value, chunks: [value.chunks[0], { ...value.chunks[1], offset: 2 }] }), /contiguous/u);
  assert.throws(() => normalizeImageArtifactManifest({ ...value, chunks: [value.chunks[0], { ...value.chunks[1], name: value.chunks[0].name }] }), /unique/u);
  assert.throws(() => normalizeImageArtifactManifest({ ...value, chunks: [value.chunks[0]] }), /exactly cover/u);
});
