import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHyperVEnvironmentLocation } from '../src/runtime/providers/hyperv-environment-location.js';
import { createLibvirtEnvironmentLocation } from '../src/runtime/providers/libvirt-environment-location.js';

const identity = 'a'.repeat(32);
const target = 'env-0123456789abcdef0123456789abcdef';
function reference(namespace, scope) { return `db-${namespace}-${createHash('sha256').update(scope).digest('hex').slice(0, 16)}`; }

test('Hyper-V provider location preserves existing owned identity formulas', () => {
  const location = createHyperVEnvironmentLocation(identity);
  assert.deepEqual(location.environment(target), {
    reference: reference('env', `${identity}:persistent:${target}`),
    proof: `devbridge-owned:${identity}:persistent:${target}:v1`,
  });
  const network = location.network();
  assert.equal(network.reference, reference('network', `${identity}:network:`));
  assert.equal(network.proof, `devbridge-owned:${identity}:network:default:v1`);
  assert.match(network.prefix, /^192\.168\.\d+\.0\/24$/u);
});

test('libvirt provider location preserves domain/network identity without leaking it upward', () => {
  const location = createLibvirtEnvironmentLocation(identity);
  const environment = location.environment(target);
  assert.equal(environment.reference, reference('env', `${identity}:persistent:${target}`));
  assert.equal(environment.proof, `devbridge-owned:${identity}:persistent:${target}:v1`);
  assert.match(environment.identity, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.deepEqual(location.network(), {
    reference: reference('network', `${identity}:network:`),
    proof: `devbridge-owned:${identity}:network:v1`,
  });
});
