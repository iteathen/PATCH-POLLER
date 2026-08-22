export function createImageRetention({ declarations, cache } = {}) {
  if (!declarations || typeof declarations.list !== 'function') throw new TypeError('image retention declaration contract is incomplete');
  if (!cache || typeof cache.collect !== 'function') throw new TypeError('image retention cache contract is incomplete');
  return Object.freeze({
    async collect() {
      const records = await declarations.list();
      if (!Array.isArray(records)) throw new TypeError('image retention declarations are invalid');
      const protectedIdentities = [...new Set(records.map((record) => record?.declaration?.image?.identity).filter((value) => typeof value === 'string'))].sort();
      const result = await cache.collect({ protectedIdentities });
      return Object.freeze({ protectedIdentities: Object.freeze(protectedIdentities), removed: Object.freeze([...(result?.removed ?? [])]) });
    },
  });
}
