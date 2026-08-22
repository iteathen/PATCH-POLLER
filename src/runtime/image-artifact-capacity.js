import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';

const HEADROOM_BYTES = 64 * 1024 * 1024;
function bytes(value, name) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`); return value; }
function safeSum(values) { let total = 0; for (const value of values) { if (value > Number.MAX_SAFE_INTEGER - total) throw new RangeError('image recovery storage requirement exceeds safe integer range'); total += value; } return total; }

export function imageArtifactCapacityRequirement({ downloadBytes, encodedBytes, canonicalBytes, replacementBytes = 0 } = {}) {
  const download = bytes(downloadBytes, 'image recovery downloadBytes');
  const encoded = bytes(encodedBytes, 'image recovery encodedBytes');
  const canonical = bytes(canonicalBytes, 'image recovery canonicalBytes');
  const replacement = bytes(replacementBytes, 'image recovery replacementBytes');
  return safeSum([download, encoded, canonical, canonical, replacement, HEADROOM_BYTES]);
}

export function createImageArtifactCapacity({ directory, inspect = statfs } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('image recovery capacity directory is required');
  if (typeof inspect !== 'function') throw new TypeError('image recovery capacity inspection contract is invalid');
  const root = path.resolve(directory);
  return Object.freeze({ async ensure(input) {
    const requiredBytes = imageArtifactCapacityRequirement(input);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const observed = await inspect(root, { bigint: true });
    const blockSize = BigInt(observed?.bsize ?? 0); const availableBlocks = BigInt(observed?.bavail ?? observed?.bfree ?? 0);
    const available = blockSize * availableBlocks;
    if (blockSize <= 0n || availableBlocks < 0n) throw new Error('image recovery storage availability is unobservable');
    if (available < BigInt(requiredBytes)) throw new Error(`insufficient image recovery storage: required=${requiredBytes} available=${available.toString()}`);
    return Object.freeze({ ready: true, requiredBytes, availableBytes: available.toString() });
  } });
}
