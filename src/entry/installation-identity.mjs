import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function fail(message) { throw new Error(message); }

export async function entryInstallationTag(home, { platform = process.platform } = {}) {
  if (typeof home !== 'string' || !home) fail('installation home is invalid');
  const resolved = path.resolve(home);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  let canonical = await realpath(resolved);
  if (platform === 'win32') canonical = canonical.toLowerCase();
  const identity = createHash('sha256').update(`devbridge/installation-v1\0${canonical}`, 'utf8').digest('hex');
  return `DB-${identity.slice(0, 12).toUpperCase()}`;
}
