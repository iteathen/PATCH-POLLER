import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const GENERIC = [new URL('../src/values/base-image-identity.js', import.meta.url), new URL('../src/runtime/image-artifact-manifest.js', import.meta.url), new URL('../src/runtime/image-artifact-bundle.js', import.meta.url), new URL('../src/runtime/image-artifact-acquisition.js', import.meta.url), new URL('../src/runtime/image-artifact-capacity.js', import.meta.url)];
const FORBIDDEN = ['GitHub', 'release', 'api.github.com', 'S3', 'bucket', 'object store', 'BaseImageLibrary', 'Hyper-V', 'libvirt'];
test('generic image artifact lifecycle contains no source or provider identity', async () => { for (const file of GENERIC) { const source = await readFile(file, 'utf8'); for (const term of FORBIDDEN) assert.equal(source.includes(term), false, `${file.pathname} leaked ${term}`); } });
