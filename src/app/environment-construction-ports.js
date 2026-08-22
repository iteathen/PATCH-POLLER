export function createEnvironmentImagePort({ availability } = {}) {
  if (!availability || typeof availability.ensure !== 'function') throw new TypeError('environment image availability contract is incomplete');
  return Object.freeze({
    async ensure({ image }) {
      const result = await availability.ensure({ identity: image.identity, generation: image.generation });
      if (!result || !['local', 'reconstructed'].includes(result.state)) throw new Error('exact environment image did not become available');
      return Object.freeze({ ready: true });
    },
  });
}

export function createEnvironmentResourcePort({ state, settings } = {}) {
  const methods = ['inspect', 'ensureStorage', 'ensureNetwork'];
  if (!state || methods.some((name) => typeof state[name] !== 'function')) throw new TypeError('environment resource state contract is incomplete');
  if (!settings || typeof settings.resolve !== 'function') throw new TypeError('environment resource settings contract is incomplete');
  return Object.freeze({
    async ensure({ profile, resources, boot, network }) {
      await settings.resolve({ profile, resources, boot });
      if (!network || typeof network.requirement !== 'string' || network.requirement.length === 0) throw new TypeError('environment network requirement is invalid');
      const before = await state.inspect();
      if (before?.capabilities?.management?.ready !== true) throw new Error(before?.capabilities?.management?.reason ?? 'environment management is unavailable');
      const storage = await state.ensureStorage();
      if (storage?.ready !== true) throw new Error(storage?.reason ?? 'environment storage is unavailable');
      const networking = await state.ensureNetwork();
      if (networking?.ready !== true) throw new Error(networking?.reason ?? 'environment networking is unavailable');
      return Object.freeze({ ready: true });
    },
  });
}
