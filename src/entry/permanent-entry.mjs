const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_SELECTOR_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;

export const PERMANENT_ENTRY_PROTOCOL = 1;
export const RUNNER_SUBJECT_PROTOCOL = 'devbridge/entry-runner-subject-v1';

function fail(message) { throw new Error(message); }

function boundedText(value, name, limit = MAX_LABEL_LENGTH) {
  const text = String(value ?? '');
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) fail(`${name} is invalid`);
  return text;
}

function selectorValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) fail(`${flag} requires a local selector value`);
  return boundedText(value, flag, MAX_SELECTOR_LENGTH);
}

function installSelector(current, next) {
  if (current) fail('Only one permanent-entry selector may be supplied.');
  return Object.freeze(next);
}

export function parsePermanentEntryArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('permanent-entry argv must be an array');
  let selector = null;
  const passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--ref' || value === '--branch') {
      const selected = selectorValue(argv, index, value);
      selector = installSelector(selector, EXACT_HEAD.test(selected.toLowerCase())
        ? { kind: 'exact', value: selected.toLowerCase() }
        : { kind: 'ref', value: selected });
      index += 1;
      continue;
    }

    if (value === '--channel' && argv[index + 1] === 'stable') {
      selector = installSelector(selector, { kind: 'channel', value: 'stable' });
      // Stable is also a valid runner/runtime channel. Preserve it across the
      // permanent-entry boundary so adopting this layer does not silently
      // change the downstream invocation semantics.
      passthrough.push(value, 'stable');
      index += 1;
      continue;
    }

    passthrough.push(value);
  }

  return Object.freeze({
    selector: selector ?? Object.freeze({ kind: 'channel', value: 'stable' }),
    argv: Object.freeze([...passthrough]),
  });
}

export function normalizeRunnerSubject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('runner subject is missing');
  if (input.protocol !== RUNNER_SUBJECT_PROTOCOL) fail('runner subject protocol is unsupported');
  const head = String(input.head ?? '').toLowerCase();
  const sha256 = String(input.sha256 ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head)) fail('runner subject head must be an exact 40-hex commit');
  if (!EXACT_DIGEST.test(sha256)) fail('runner subject sha256 must be an exact 64-hex digest');
  if (!Number.isSafeInteger(input.minimumEntryProtocol) || input.minimumEntryProtocol < 1) {
    fail('runner subject minimum entry protocol is invalid');
  }
  if (input.minimumEntryProtocol > PERMANENT_ENTRY_PROTOCOL) {
    fail(`runner requires permanent-entry protocol ${input.minimumEntryProtocol}, but this entry supports ${PERMANENT_ENTRY_PROTOCOL}`);
  }
  return Object.freeze({
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256,
    minimumEntryProtocol: input.minimumEntryProtocol,
    channel: boundedText(input.channel, 'runner subject channel'),
    releaseId: boundedText(input.releaseId, 'runner subject release identity'),
  });
}

export function sameRunnerSubject(left, right) {
  return left.protocol === right.protocol &&
    left.head === right.head &&
    left.sha256 === right.sha256 &&
    left.minimumEntryProtocol === right.minimumEntryProtocol &&
    left.channel === right.channel &&
    left.releaseId === right.releaseId;
}

function requirePort(value, name, method) {
  if (!value || typeof value[method] !== 'function') throw new TypeError(`${name}.${method} must be a function`);
}

async function prepareExact(subject, runnerProvider) {
  const prepared = await runnerProvider.prepare(subject);
  if (!prepared || typeof prepared !== 'object' || typeof prepared.launch !== 'function') {
    fail('runner provider did not return a launchable verified subject');
  }
  const preparedSubject = normalizeRunnerSubject(prepared.subject);
  if (!sameRunnerSubject(subject, preparedSubject)) fail('prepared runner subject changed after exact resolution');
  return { prepared, preparedSubject };
}

export async function runPermanentEntry(argv, { subjectAuthority, runnerProvider } = {}) {
  requirePort(subjectAuthority, 'subjectAuthority', 'resolve');
  requirePort(runnerProvider, 'runnerProvider', 'prepare');

  const request = parsePermanentEntryArgs(argv);
  let subject = normalizeRunnerSubject(await subjectAuthority.resolve(request.selector));
  let preparedResult;

  try {
    preparedResult = await prepareExact(subject, runnerProvider);
  } catch (error) {
    if (typeof subjectAuthority.recover !== 'function') throw error;
    const recovered = await subjectAuthority.recover(subject, error);
    if (recovered == null) throw error;
    const fallback = normalizeRunnerSubject(recovered);
    if (sameRunnerSubject(subject, fallback)) fail('runner recovery returned the failed subject again');
    subject = fallback;
    preparedResult = await prepareExact(subject, runnerProvider);
  }

  if (typeof subjectAuthority.accept === 'function') {
    await subjectAuthority.accept(preparedResult.preparedSubject, request.selector);
  }

  return preparedResult.prepared.launch([...request.argv]);
}
