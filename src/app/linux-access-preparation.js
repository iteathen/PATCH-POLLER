const DESTINATION = '/var/lib/devbridge/access/seed.json';

function sameConnection(left, right) {
  return left?.family === 'linux' && right?.family === 'linux' && left.user === right.user && left.identityFile === right.identityFile && left.knownHostsFile === right.knownHostsFile;
}

export function createLinuxAccessPreparation({ material, delivery, probe, settleMs = 90_000, pollMs = 1_000 } = {}) {
  if (!material || typeof material.connection !== 'function' || typeof material.prepare !== 'function') throw new TypeError('Linux access material contract is incomplete');
  if (!delivery || typeof delivery.put !== 'function') throw new TypeError('Linux access delivery contract is incomplete');
  if (!probe || typeof probe.inspect !== 'function') throw new TypeError('Linux access probe contract is incomplete');
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new TypeError('Linux access settling policy is invalid');

  const connection = (target) => material.connection(target);
  const ensure = async ({ target, access }) => {
    if (!access || access.family !== 'linux') throw new TypeError('Linux access preparation requires a Linux connection');
    const expected = connection(target);
    if (!sameConnection(expected, access)) throw new Error('Linux access preparation connection changed');
    let observed = await probe.inspect(access);
    if (observed.ready === true) return Object.freeze({ ready: true, changed: false });

    const prepared = await material.prepare(target);
    try {
      if (!sameConnection(prepared.connection, access)) throw new Error('Linux access material returned another connection identity');
      await delivery.put(target, prepared.seedFile, DESTINATION);
      const deadline = Date.now() + settleMs;
      do {
        observed = await probe.inspect(access);
        if (observed.ready === true) return Object.freeze({ ready: true, changed: true });
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      } while (true);
      throw new Error(`Linux access did not become ready: ${observed.reason ?? 'unknown failure'}`);
    } finally {
      await prepared.cleanup();
    }
  };

  return Object.freeze({ connection, ensure });
}
