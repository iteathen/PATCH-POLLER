import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionProfileResourceError,
  preflightExecutionProfileMemory,
  preflightExecutionProfileStorage,
} from '../src/runtime/profile-resource-preflight.js';

test('profile memory preflight preserves a bounded host reserve', () => {
  const gib = 1024 * 1024 * 1024;
  const result = preflightExecutionProfileMemory(
    { memoryBytes: 4 * gib },
    { availableBytes: 8 * gib, minimumReserveBytes: gib },
  );
  assert.equal(result.ready, true);
  assert.equal(result.resource, 'memory');
  assert.equal(result.requestedBytes, 4 * gib);
  assert.equal(result.reserveBytes, gib);
  assert.equal(result.requiredBytes, 5 * gib);
});

test('profile memory preflight produces a typed resource failure before provider allocation', () => {
  const gib = 1024 * 1024 * 1024;
  assert.throws(
    () => preflightExecutionProfileMemory(
      { memoryBytes: 4 * gib },
      { availableBytes: 4 * gib, minimumReserveBytes: gib },
    ),
    (error) => {
      assert.equal(error instanceof ExecutionProfileResourceError, true);
      assert.equal(error.name, 'ExecutionProfileResourceError');
      assert.equal(error.code, 'PROFILE_RESOURCES_UNAVAILABLE');
      assert.equal(error.resource, 'memory');
      assert.equal(error.requestedBytes, 4 * gib);
      assert.equal(error.availableBytes, 4 * gib);
      assert.equal(error.reserveBytes, gib);
      return true;
    },
  );
});

test('profile storage preflight accounts for writable growth and host reserve', () => {
  const gib = 1024 * 1024 * 1024;
  const result = preflightExecutionProfileStorage(
    { sourceBytes: 6 * gib },
    { availableBytes: 12 * gib, minimumReserveBytes: 2 * gib, minimumWritableBytes: gib },
  );
  assert.equal(result.ready, true);
  assert.equal(result.resource, 'storage');
  assert.equal(result.requestedBytes, 6 * gib);
  assert.equal(result.reserveBytes, 2 * gib);
  assert.equal(result.requiredBytes, 8 * gib);
});

test('profile storage preflight produces the same typed resource failure before provider allocation', () => {
  const gib = 1024 * 1024 * 1024;
  assert.throws(
    () => preflightExecutionProfileStorage(
      { sourceBytes: 6 * gib },
      { availableBytes: 7 * gib, minimumReserveBytes: 2 * gib, minimumWritableBytes: gib },
    ),
    (error) => {
      assert.equal(error instanceof ExecutionProfileResourceError, true);
      assert.equal(error.code, 'PROFILE_RESOURCES_UNAVAILABLE');
      assert.equal(error.resource, 'storage');
      assert.equal(error.requestedBytes, 6 * gib);
      assert.equal(error.availableBytes, 7 * gib);
      assert.equal(error.reserveBytes, 2 * gib);
      return true;
    },
  );
});
