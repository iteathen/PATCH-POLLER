export function createEnvironmentImageCache({ state } = {}) {
  const methods = ['observeImage', 'verifyImage', 'publishImage', 'listImages', 'retireImage', 'collectImages'];
  if (!state || methods.some((name) => typeof state[name] !== 'function')) throw new TypeError('environment image state contract is incomplete');
  return Object.freeze({
    observe: (identity) => state.observeImage(identity),
    verify: (identity) => state.verifyImage(identity),
    publish: (input) => state.publishImage(input),
    list: () => state.listImages(),
    retire: (identity) => state.retireImage(identity),
    collect: (options) => state.collectImages(options),
  });
}
