import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVGuestFileDelivery } from '../src/runtime/providers/hyperv-guest-file-delivery.js';

const identity = 'a'.repeat(32);
const target = 'env-0123456789abcdef0123456789abcdef';

test('Hyper-V guest delivery binds copy to exact owned environment proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hyperv-delivery-'));
  try {
    const source = path.join(root, 'seed.json');
    await writeFile(source, '{}\n');
    let supplied = null;
    const delivery = new HyperVGuestFileDelivery({
      identity,
      invoke: async (input) => { supplied = input; return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"delivered":true}', stderr: '' }; },
    });
    assert.deepEqual(await delivery.put(target, source, '/var/lib/devbridge/access/seed.json'), { delivered: true });
    const payload = JSON.parse(supplied.input);
    assert.equal(payload.reference, `db-env-${createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 16)}`);
    assert.equal(payload.proof, `devbridge-owned:${identity}:persistent:${target}:v1`);
    assert.equal(payload.destination, '/var/lib/devbridge/access/seed.json');
    assert.match(supplied.executable, /powershell\.exe$/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Hyper-V guest delivery refuses symlink or missing source before provider invocation', async () => {
  let invoked = false;
  const delivery = new HyperVGuestFileDelivery({ identity, invoke: async () => { invoked = true; } });
  await assert.rejects(() => delivery.put(target, '/definitely/missing', '/guest/path'));
  assert.equal(invoked, false);
});
