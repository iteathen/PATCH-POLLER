import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_ID = /^img-[a-f0-9]{32}$/u;
function imageId(value) { if (typeof value !== 'string' || !IMAGE_ID.test(value)) throw new TypeError('image identity is invalid'); return value; }
async function measure(file) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}
async function regularFile(file) {
  try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink(); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export function createRecoverableImageCache({ library, quarantineDirectory, now = () => new Date().toISOString(), id = randomUUID } = {}) {
  if (!library || typeof library.verify !== 'function' || typeof library.publish !== 'function' || typeof library.observe !== 'function' || typeof library.list !== 'function' || typeof library.retire !== 'function' || typeof library.collect !== 'function') throw new TypeError('image cache library contract is incomplete');
  if (typeof quarantineDirectory !== 'string' || quarantineDirectory.length === 0) throw new TypeError('image cache quarantine directory is required');
  if (typeof now !== 'function' || typeof id !== 'function') throw new TypeError('image cache quarantine dependencies are invalid');
  const root = path.resolve(quarantineDirectory);
  return Object.freeze({
    verify: (identity) => library.verify(imageId(identity)),
    publish: (input, options) => library.publish(input, options),
    async quarantine(identity) {
      const selected = imageId(identity);
      const observed = await library.observe(selected);
      if (observed?.entry == null) return Object.freeze({ changed: false, identity: selected, retained: false });
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('image cache quarantine directory must be a real directory');
      let retained = null;
      if (typeof observed.location === 'string' && await regularFile(observed.location)) {
        const token = String(id());
        if (!/^[A-Za-z0-9-]{1,80}$/u.test(token)) throw new TypeError('image cache quarantine identity is invalid');
        const temporary = path.join(root, `.${selected}-${token}.tmp`);
        const final = path.join(root, `${selected}-${token}.quarantine`);
        try {
          await copyFile(observed.location, temporary, 1);
          const measured = await measure(temporary);
          await rename(temporary, final);
          const record = { protocol: 'devbridge/image-cache-quarantine-v1', identity: selected, observedDigest: measured.sha256, observedSize: measured.size, expectedDigest: observed.entry.digest ?? null, expectedSize: observed.entry.size ?? null, quarantinedAt: now() };
          await writeFile(`${final}.json`, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          retained = Object.freeze({ file: path.basename(final), record: path.basename(`${final}.json`), ...record });
        } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      }
      const others = (await library.list()).map((entry) => entry.identity).filter((value) => value !== selected);
      await library.retire(selected);
      const collected = await library.collect({ protectedIdentities: others });
      if (!Array.isArray(collected?.removed) || !collected.removed.includes(selected)) throw new Error('image cache quarantine could not remove the exact retired cache subject');
      return Object.freeze({ changed: true, identity: selected, retained: retained != null, quarantine: retained });
    },
  });
}
