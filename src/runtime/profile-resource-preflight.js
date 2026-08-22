import { lstat, statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import path from 'node:path';

const MIN_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;
const MIN_STORAGE_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_WRITABLE_STORAGE_BYTES = 1024 * 1024 * 1024;
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

export class ExecutionProfileResourceError extends Error {
  constructor({ resource = 'memory', requestedBytes, availableBytes, reserveBytes }) {
    const noun = resource === 'storage' ? 'writable storage' : 'startup memory';
    super(`execution profile requires ${requestedBytes} bytes of ${noun} plus ${reserveBytes} bytes of host reserve, but only ${availableBytes} bytes are currently free`);
    this.name = 'ExecutionProfileResourceError';
    this.code = 'PROFILE_RESOURCES_UNAVAILABLE';
    this.resource = resource;
    this.requestedBytes = requestedBytes;
    this.availableBytes = availableBytes;
    this.reserveBytes = reserveBytes;
  }
}

function safeBytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_BYTES) throw new TypeError(`${name} is invalid`);
  return value;
}

function checkedTotal(requestedBytes, reserveBytes) {
  const value = requestedBytes + reserveBytes;
  if (!Number.isSafeInteger(value)) throw new TypeError('execution profile resource requirement is too large');
  return value;
}

export function preflightExecutionProfileMemory(settings, {
  availableBytes = freemem(),
  minimumReserveBytes = MIN_MEMORY_RESERVE_BYTES,
} = {}) {
  const requestedBytes = safeBytes(settings?.memoryBytes, 'execution profile memory request');
  const freeBytes = safeBytes(availableBytes, 'available host memory');
  const minimumReserve = safeBytes(minimumReserveBytes, 'host memory reserve');
  const reserveBytes = Math.max(minimumReserve, Math.ceil(requestedBytes / 4));
  const requiredBytes = checkedTotal(requestedBytes, reserveBytes);
  if (freeBytes < requiredBytes) {
    throw new ExecutionProfileResourceError({ resource: 'memory', requestedBytes, availableBytes: freeBytes, reserveBytes });
  }
  return Object.freeze({
    ready: true,
    resource: 'memory',
    requestedBytes,
    availableBytes: freeBytes,
    reserveBytes,
    requiredBytes,
  });
}

export function preflightExecutionProfileStorage({ sourceBytes }, {
  availableBytes,
  minimumReserveBytes = MIN_STORAGE_RESERVE_BYTES,
  minimumWritableBytes = MIN_WRITABLE_STORAGE_BYTES,
} = {}) {
  const sourceSize = safeBytes(sourceBytes, 'execution profile source storage size');
  const freeBytes = safeBytes(availableBytes, 'available host storage');
  const minimumReserve = safeBytes(minimumReserveBytes, 'host storage reserve');
  const minimumWritable = safeBytes(minimumWritableBytes, 'minimum writable profile storage');
  const requestedBytes = Math.max(minimumWritable, sourceSize);
  const reserveBytes = Math.max(minimumReserve, Math.ceil(requestedBytes / 4));
  const requiredBytes = checkedTotal(requestedBytes, reserveBytes);
  if (freeBytes < requiredBytes) {
    throw new ExecutionProfileResourceError({ resource: 'storage', requestedBytes, availableBytes: freeBytes, reserveBytes });
  }
  return Object.freeze({
    ready: true,
    resource: 'storage',
    requestedBytes,
    availableBytes: freeBytes,
    reserveBytes,
    requiredBytes,
    sourceBytes: sourceSize,
  });
}

async function existingStoragePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('execution profile storage directory is invalid');
  let current = path.resolve(value);
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('execution profile storage parent must be a real directory');
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error('execution profile storage parent is unavailable');
      current = parent;
    }
  }
}

function bigintBytes(value, name) {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(MAX_SAFE_BYTES)) throw new TypeError(`${name} is outside the supported range`);
  return Number(value);
}

export async function preflightExecutionProfileStoragePaths({ directory, sourceLocation }) {
  if (typeof sourceLocation !== 'string' || sourceLocation.length === 0 || sourceLocation.includes('\0')) {
    throw new TypeError('execution profile source storage location is invalid');
  }
  const source = await lstat(path.resolve(sourceLocation), { bigint: true });
  if (!source.isFile() || source.isSymbolicLink()) throw new Error('execution profile source storage must be a real file');
  const probe = await existingStoragePath(directory);
  const filesystem = await statfs(probe, { bigint: true });
  const availableBytes = bigintBytes(filesystem.bavail * filesystem.bsize, 'available host storage');
  const sourceBytes = bigintBytes(source.size, 'execution profile source storage size');
  return preflightExecutionProfileStorage({ sourceBytes }, { availableBytes });
}
