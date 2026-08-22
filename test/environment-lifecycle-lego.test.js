import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CORE_PATHS = [
  new URL('../src/runtime/environment-declaration.js', import.meta.url),
  new URL('../src/runtime/environment-observation.js', import.meta.url),
  new URL('../src/runtime/environment-lifecycle-journal.js', import.meta.url),
];

const FORBIDDEN_TERMS = [
  'Hyper-V', 'libvirt', 'VHDX', 'qcow2', 'PowerShell', 'domain XML', 'VM name', 'disk path',
  '../app/', './providers/', '../providers/', 'execution-profile-routing', 'repository-execution', 'environment-foundation',
];

test('lifecycle core remains isolated from foreign implementation identities', async () => {
  for (const file of CORE_PATHS) {
    const source = await readFile(file, 'utf8');
    for (const term of FORBIDDEN_TERMS) assert.equal(source.includes(term), false, `${file.pathname} leaked ${term}`);
  }
});
