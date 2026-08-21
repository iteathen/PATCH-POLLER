import { lstat, rm } from 'node:fs/promises';
import process from 'node:process';

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function removeDirectory(target) {
  if (!(await exists(target))) return { state: 'verified-absent', removed: false };
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('owned resource is not a real directory');
  await rm(target, { recursive: true, force: false });
  if (await exists(target)) throw new Error('owned resource remains after cleanup');
  return { state: 'verified-absent', removed: true };
}

const [, , action, target, ...rest] = process.argv;
if (rest.length !== 0 || action !== 'remove-directory' || typeof target !== 'string' || target.length === 0) {
  process.stderr.write('resource-agent received an invalid request\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(await removeDirectory(target))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.name ?? 'Error'}: ${String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 1024)}\n`);
    process.exitCode = 1;
  }
}
