import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_OBSERVATION_PROTOCOL,
  environmentObservationCondition,
  environmentObservationMatchesDeclaration,
  normalizeEnvironmentObservation,
} from '../src/runtime/environment-observation.js';

function observation(overrides = {}) {
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: 'environment-0123456789abcdef0123456789abcdef',
    declarationRevision: 2,
    implementationGeneration: 'generation-1',
    materialization: 'present',
    systemStorage: 'present',
    attachment: 'ready',
    enrollment: 'ready',
    bootstrap: 'ready',
    guest: 'healthy',
    transition: 'clear',
    ...overrides,
  };
}

test('observation distinguishes missing system storage from other degradation', () => {
  assert.equal(environmentObservationCondition(observation()), 'healthy');
  assert.equal(environmentObservationCondition(observation({ systemStorage: 'absent' })), 'system-storage-missing');
  assert.equal(environmentObservationCondition(observation({ systemStorage: 'invalid' })), 'system-storage-invalid');
  assert.equal(environmentObservationCondition(observation({ enrollment: 'stale' })), 'enrollment-stale');
  assert.equal(environmentObservationCondition(observation({ transition: 'ambiguous' })), 'transition-ambiguous');
});

test('observation distinguishes never-created from a missing implementation', () => {
  assert.throws(() => normalizeEnvironmentObservation(observation({ materialization: 'none' })), /cannot name an implementation generation/u);
  assert.throws(() => normalizeEnvironmentObservation(observation({ materialization: 'missing', implementationGeneration: null })), /must retain its implementation generation/u);
  assert.equal(environmentObservationCondition(observation({ materialization: 'none', implementationGeneration: null })), 'materialization-not-created');
  assert.equal(environmentObservationCondition(observation({ materialization: 'missing' })), 'materialization-missing');
});

test('observation rejects implementation details outside the neutral contract', () => {
  assert.throws(() => normalizeEnvironmentObservation({ ...observation(), storagePath: 'foreign' }), /storagePath is not allowed/u);
});

test('observation basis exposes stale declaration evidence without guessing', () => {
  assert.equal(environmentObservationMatchesDeclaration(observation(), 2), true);
  assert.equal(environmentObservationMatchesDeclaration(observation(), 3), false);
});
