import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('image availability composition names only local contracts', async () => { const source = await readFile(new URL('../src/app/image-availability.js', import.meta.url), 'utf8'); for (const term of ['GitHub', 'release', 'Hyper-V', 'libvirt', 'VHDX', 'qcow2']) assert.equal(source.includes(term), false, `composition leaked ${term}`); });
