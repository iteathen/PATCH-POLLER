import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CORE = [new URL('../src/runtime/environment-construction.js', import.meta.url), new URL('../src/runtime/environment-create.js', import.meta.url)];
const FORBIDDEN = ['Hyper-V', 'libvirt', 'VHDX', 'qcow2', 'PowerShell', 'SSH', 'knownHosts', 'password', 'repository-execution', 'execution-profile-routing', 'environment-foundation', './providers/', '../providers/'];
test('construction core contains no provider, guest-access, or routing implementation identity', async () => { for (const file of CORE) { const source = await readFile(file, 'utf8'); for (const term of FORBIDDEN) assert.equal(source.includes(term), false, `${file.pathname} leaked ${term}`); } });
