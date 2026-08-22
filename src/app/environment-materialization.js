import { normalizeEnvironmentObservation, ENVIRONMENT_OBSERVATION_PROTOCOL } from '../runtime/environment-observation.js';

function assertState(value) {
  const methods = ['listEnvironments', 'ensureEnvironment'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment materialization state contract is incomplete');
  return value;
}
function assertResolver(value, name) {
  if (!value || typeof value.resolve !== 'function') throw new TypeError(`environment materialization ${name} contract is incomplete`);
  return value;
}
function requireRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.declaration) throw new TypeError('environment materialization request is invalid');
  return value;
}
function implementation(record) {
  if (!record || typeof record.identity !== 'string' || !/^env-[a-f0-9]{32}$/u.test(record.identity)) throw new Error('environment materialization returned an invalid implementation generation');
  return record.identity;
}

export function createEnvironmentMaterialization({ state, subject, settings } = {}) {
  const localState = assertState(state);
  const subjectResolver = assertResolver(subject, 'subject');
  const settingsResolver = assertResolver(settings, 'settings');

  const resolve = async (request) => {
    const input = requireRequest(request);
    const localSubject = await subjectResolver.resolve(Object.freeze({
      environmentIdentity: input.environmentIdentity,
      profile: input.declaration.profile,
    }));
    if (typeof localSubject !== 'string' || localSubject.length === 0 || localSubject.includes('\0')) throw new Error('environment materialization subject resolution is invalid');
    return { input, localSubject };
  };

  const observe = async (request) => {
    const { input, localSubject } = await resolve(request);
    const matches = (await localState.listEnvironments()).filter((entry) => entry?.record?.subject === localSubject && entry?.record?.profile === input.declaration.profile);
    if (matches.length === 0) {
      return normalizeEnvironmentObservation({
        protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        declarationRevision: input.declarationRevision,
        implementationGeneration: null,
        materialization: 'none',
        systemStorage: 'unknown',
        attachment: 'unknown',
        enrollment: 'unknown',
        bootstrap: 'unknown',
        guest: 'unknown',
        transition: 'clear',
      });
    }
    if (matches.length !== 1) {
      return normalizeEnvironmentObservation({
        protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        declarationRevision: input.declarationRevision,
        implementationGeneration: null,
        materialization: 'ambiguous',
        systemStorage: 'unknown',
        attachment: 'unknown',
        enrollment: 'unknown',
        bootstrap: 'unknown',
        guest: 'unknown',
        transition: 'ambiguous',
      });
    }
    const selected = matches[0];
    const generation = implementation(selected.record);
    const raw = selected.observation ?? {};
    const owned = raw.owned === true;
    const exists = raw.exists === true;
    if (!owned && exists) {
      return normalizeEnvironmentObservation({
        protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        declarationRevision: input.declarationRevision,
        implementationGeneration: generation,
        materialization: 'ambiguous',
        systemStorage: 'unknown', attachment: 'unknown', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown', transition: 'ambiguous',
      });
    }
    const storageMatches = raw.storage?.sourceIdentity === input.declaration.image.identity;
    const storageState = raw.compatible === true && storageMatches ? 'present' : raw.storage != null ? 'invalid' : 'unknown';
    const attachment = raw.compatible === true && storageMatches ? 'ready' : 'invalid';
    return normalizeEnvironmentObservation({
      protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
      environmentIdentity: input.environmentIdentity,
      declarationRevision: input.declarationRevision,
      implementationGeneration: generation,
      materialization: exists ? 'present' : 'missing',
      systemStorage: storageState,
      attachment,
      enrollment: 'unknown',
      bootstrap: 'unknown',
      guest: 'unknown',
      transition: 'clear',
    });
  };

  return Object.freeze({
    observe,
    async ensure(request) {
      const { input, localSubject } = await resolve(request);
      const localSettings = await settingsResolver.resolve(Object.freeze({
        environmentIdentity: input.environmentIdentity,
        profile: input.declaration.profile,
        resources: input.declaration.resources,
        boot: input.declaration.boot,
      }));
      const result = await localState.ensureEnvironment({
        subject: localSubject,
        profile: input.declaration.profile,
        sourceIdentity: input.declaration.image.identity,
        settings: localSettings,
      });
      const generation = implementation(result?.record);
      return Object.freeze({ ready: result?.observation?.exists === true && result?.observation?.owned === true && result?.observation?.compatible === true, implementationGeneration: generation });
    },
  });
}
