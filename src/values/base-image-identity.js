import { createHash } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function baseImageIdentity(profile, generation, digest) {
  const normalizedProfile = safeId(profile, 'image profile');
  const normalizedGeneration = safeId(generation, 'image generation');
  const normalizedDigest = String(digest ?? '').toLowerCase();
  if (!DIGEST.test(normalizedDigest)) throw new TypeError('image digest is invalid');
  const value = createHash('sha256')
    .update(`${normalizedProfile}\0${normalizedGeneration}\0${normalizedDigest}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `img-${value}`;
}
