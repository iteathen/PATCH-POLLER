export const ENVIRONMENT_OBSERVATION_PROTOCOL = 'devbridge/environment-observation-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const STATES = Object.freeze({
  materialization: new Set(['none', 'present', 'missing', 'unavailable', 'ambiguous']),
  systemStorage: new Set(['unknown', 'absent', 'present', 'invalid']),
  attachment: new Set(['unknown', 'ready', 'invalid']),
  enrollment: new Set(['unknown', 'ready', 'missing', 'stale']),
  bootstrap: new Set(['unknown', 'ready', 'degraded']),
  guest: new Set(['unknown', 'healthy', 'degraded', 'unreachable']),
  transition: new Set(['clear', 'incomplete', 'ambiguous']),
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function positiveSafeInteger(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`); return value; }
function state(value, name) { if (!STATES[name].has(value)) throw new TypeError(`environment observation.${name} is invalid`); return value; }

export function normalizeEnvironmentObservation(raw) {
  const value = requireObject(raw, 'environment observation');
  onlyKeys(value, new Set([
    'protocol', 'environmentIdentity', 'declarationRevision', 'implementationGeneration', 'materialization', 'systemStorage',
    'attachment', 'enrollment', 'bootstrap', 'guest', 'transition',
  ]), 'environment observation');
  if (value.protocol !== ENVIRONMENT_OBSERVATION_PROTOCOL) throw new TypeError('environment observation protocol is unsupported');
  const materialization = state(value.materialization, 'materialization');
  const implementationGeneration = value.implementationGeneration == null
    ? null
    : safeId(value.implementationGeneration, 'environment observation.implementationGeneration');
  if (materialization === 'none' && implementationGeneration != null) throw new TypeError('unmaterialized environment cannot name an implementation generation');
  if (materialization === 'missing' && implementationGeneration == null) throw new TypeError('missing environment materialization must retain its implementation generation identity');
  return Object.freeze({
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: safeId(value.environmentIdentity, 'environment observation.environmentIdentity'),
    declarationRevision: positiveSafeInteger(value.declarationRevision, 'environment observation.declarationRevision'),
    implementationGeneration,
    materialization,
    systemStorage: state(value.systemStorage, 'systemStorage'),
    attachment: state(value.attachment, 'attachment'),
    enrollment: state(value.enrollment, 'enrollment'),
    bootstrap: state(value.bootstrap, 'bootstrap'),
    guest: state(value.guest, 'guest'),
    transition: state(value.transition, 'transition'),
  });
}

export function environmentObservationCondition(raw) {
  const value = normalizeEnvironmentObservation(raw);
  if (value.transition === 'ambiguous') return 'transition-ambiguous';
  if (value.transition === 'incomplete') return 'transition-incomplete';
  if (value.materialization === 'ambiguous') return 'materialization-ambiguous';
  if (value.materialization === 'unavailable') return 'materialization-unobservable';
  if (value.materialization === 'none') return 'materialization-not-created';
  if (value.materialization === 'missing') return 'materialization-missing';
  if (value.systemStorage === 'absent') return 'system-storage-missing';
  if (value.systemStorage === 'invalid') return 'system-storage-invalid';
  if (value.attachment === 'invalid') return 'attachment-invalid';
  if (value.enrollment === 'missing') return 'enrollment-missing';
  if (value.enrollment === 'stale') return 'enrollment-stale';
  if (value.bootstrap === 'degraded') return 'bootstrap-degraded';
  if (value.guest === 'unreachable') return 'guest-unreachable';
  if (value.guest === 'degraded') return 'guest-degraded';
  if ([value.systemStorage, value.attachment, value.enrollment, value.bootstrap, value.guest].includes('unknown')) return 'incomplete-observation';
  return 'healthy';
}

export function environmentObservationMatchesDeclaration(raw, declarationRevision) {
  const value = normalizeEnvironmentObservation(raw);
  if (!Number.isSafeInteger(declarationRevision) || declarationRevision < 1) throw new TypeError('environment declaration revision is invalid');
  return value.declarationRevision === declarationRevision;
}
