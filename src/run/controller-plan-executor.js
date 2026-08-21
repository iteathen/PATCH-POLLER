import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { isWithin } from '../security/workspace-policy.js';
import { ManagedScratchTransaction } from '../runtime/managed-scratch.js';
import { guardActiveTaskLease } from './lease-execution-context.js';

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileDigest(filePath) {
  return sha256Bytes(await readFile(filePath));
}

async function assertContainedNoFollow(root, relative, { allowMissing = true } = {}) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relative);
  if (!isWithin(rootResolved, target)) throw new PolicyError(`controller path escaped worktree: ${relative}`);
  const rootInfo = await lstat(rootResolved);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new PolicyError('controller worktree root must be a real directory');
  const rootReal = await realpath(rootResolved);
  const rel = path.relative(rootResolved, target);
  if (rel === '') return target;
  const segments = rel.split(path.sep).filter(Boolean);
  let cursor = rootResolved;
  let encounteredMissing = false;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (encounteredMissing || !(await exists(cursor))) {
      encounteredMissing = true;
      continue;
    }
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new PolicyError(`controller path crosses a symbolic link/junction: ${relative}`);
    const canonical = await realpath(cursor);
    if (!isWithin(rootReal, canonical)) throw new PolicyError(`controller path resolves outside worktree: ${relative}`);
  }
  if (!allowMissing && encounteredMissing) throw new PolicyError(`controller path does not exist: ${relative}`);
  return target;
}

async function atomicWrite(target, content, root) {
  const parentRelative = path.relative(root, path.dirname(target));
  await assertContainedNoFollow(root, parentRelative || '.');
  await guardActiveTaskLease();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await assertContainedNoFollow(root, parentRelative || '.', { allowMissing: false });
  const temp = `${target}.devbridge-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, target);
  await guardActiveTaskLease();
}

function operationResultEvidence(id, operation, result) {
  return {
    id,
    operation,
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    outputTruncated: result.outputTruncated === true,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    startedAt: result.startedAt ?? null,
    finishedAt: result.finishedAt ?? null,
    lastOutputAt: result.lastOutputAt ?? null,
  };
}

function primitiveAtPath(value, dotted) {
  let current = value;
  for (const segment of dotted.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) return { found: false, value: undefined };
    current = current[segment];
  }
  return { found: true, value: current };
}

export class ControllerPlanExecutor {
  #registry;
  #processRunner;
  #workspace;
  #faults;

  constructor({ operationRegistry, processRunner, workspaceManager, faultInjector = null }) {
    this.#registry = operationRegistry;
    this.#processRunner = processRunner;
    this.#workspace = workspaceManager;
    this.#faults = faultInjector;
  }

  async #applyFile(file, context) {
    const target = await assertContainedNoFollow(context.workspace.worktreeDir, file.path);
    const present = await exists(target);
    const currentDigest = present ? await fileDigest(target) : null;

    if (file.scope === 'ephemeral') {
      if (file.action === 'reserve') return { path: file.path, action: 'reserve', digest: currentDigest };
      if (present && currentDigest !== file.contentSha256) throw new PolicyError(`ephemeral create would overwrite existing path ${file.path}`);
      if (!present) await atomicWrite(target, file.content, context.workspace.worktreeDir);
      return { path: file.path, action: 'create', digest: file.contentSha256 };
    }

    if (file.action === 'create') {
      if (present && currentDigest !== file.contentSha256) throw new PolicyError(`controller create target already exists with different content: ${file.path}`);
      if (!present) await atomicWrite(target, file.content, context.workspace.worktreeDir);
      return { path: file.path, action: 'create', digest: file.contentSha256, reconciled: present };
    }
    if (file.action === 'replace') {
      if (!present) throw new PolicyError(`controller replace target does not exist: ${file.path}`);
      if (currentDigest === file.contentSha256) return { path: file.path, action: 'replace', digest: file.contentSha256, reconciled: true };
      if (currentDigest !== file.expectedSha256) throw new PolicyError(`controller replace stale digest for ${file.path}`);
      await atomicWrite(target, file.content, context.workspace.worktreeDir);
      return { path: file.path, action: 'replace', digest: file.contentSha256 };
    }
    if (file.action === 'delete') {
      if (!present) return { path: file.path, action: 'delete', digest: null, reconciled: true };
      if (currentDigest !== file.expectedSha256) throw new PolicyError(`controller delete stale digest for ${file.path}`);
      const info = await stat(target);
      if (!info.isFile()) throw new PolicyError(`controller delete only supports regular files: ${file.path}`);
      await guardActiveTaskLease();
      await rm(target, { force: false });
      await guardActiveTaskLease();
      return { path: file.path, action: 'delete', digest: null };
    }
    throw new PolicyError(`unsupported controller file action ${file.action}`);
  }

  async #cleanup(state, workspace, persist) {
    const ledger = state.controllerPlan?.cleanupLedger ?? [];
    for (const entry of ledger) {
      if (entry.state === 'verified-absent') continue;
      const target = await assertContainedNoFollow(workspace.worktreeDir, entry.path);
      entry.state = 'cleanup-planned';
      entry.updatedAt = new Date().toISOString();
      await persist();
      this.#faults?.throwIfTriggered('cleanup.before-remove', { operation: entry.path });
      if (await exists(target)) {
        const info = await lstat(target);
        if (info.isDirectory()) throw new PolicyError(`cleanup ledger entry unexpectedly became a directory: ${entry.path}`);
        if (info.isSymbolicLink()) throw new PolicyError(`cleanup ledger entry unexpectedly became a symbolic link: ${entry.path}`);
        await guardActiveTaskLease();
        await rm(target, { force: true });
        await guardActiveTaskLease();
      }
      entry.state = 'removed';
      entry.updatedAt = new Date().toISOString();
      await persist();
      if (await exists(target)) throw new PolicyError(`cleanup failed to remove ${entry.path}`);
      entry.state = 'verified-absent';
      entry.updatedAt = new Date().toISOString();
      await persist();
    }
  }

  async #cleanupEnvironmentScratch(planState, workspace, persist) {
    const entry = planState.environmentScratchCleanup;
    if (!entry || entry.state === 'verified-absent') return;
    if (!this.#processRunner || typeof this.#processRunner.cleanup !== 'function') {
      throw new PolicyError('deterministic operation used environment scratch but no cleanup capability is available');
    }
    entry.state = 'cleanup-planned';
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.updatedAt = new Date().toISOString();
    delete entry.reason;
    await persist();
    try {
      const result = await this.#processRunner.cleanup({
        executionClass: 'repository-code',
        cwd: workspace.worktreeDir,
        resource: 'scratch',
      });
      if (result?.state !== 'verified-absent' || result?.resource !== 'scratch' || typeof result?.removed !== 'boolean') {
        throw new PolicyError('repository-code cleanup did not verify environment scratch absent');
      }
      entry.state = 'verified-absent';
      entry.removed = result.removed;
      entry.evidenceIdentity = result.evidence?.identity ?? null;
      entry.updatedAt = new Date().toISOString();
      await persist();
    } catch (error) {
      entry.state = 'failed';
      entry.reason = String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 1024);
      entry.updatedAt = new Date().toISOString();
      await persist();
      throw error;
    }
  }

  async #verifyPersistentFiles(plan, planState, workspace, persist) {
    const persistentFiles = plan.files.filter((file) => file.scope === 'persistent');
    planState.phase = 'verifying-persistent-files';
    planState.persistentVerification = {
      required: persistentFiles.length,
      verified: 0,
      files: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    await persist();

    for (const file of persistentFiles) {
      const record = {
        path: file.path,
        action: file.action,
        expectedSha256: file.action === 'delete' ? null : file.contentSha256,
        observedSha256: null,
        state: 'checking',
        checkedAt: new Date().toISOString(),
      };
      planState.persistentVerification.files.push(record);
      await persist();

      try {
        const target = await assertContainedNoFollow(workspace.worktreeDir, file.path);
        const present = await exists(target);

        if (file.action === 'delete') {
          if (present) {
            record.observedSha256 = await fileDigest(target).catch(() => null);
            throw new PolicyError(`controller persistent delete target was recreated after operations/cleanup: ${file.path}`);
          }
          record.state = 'verified-absent';
        } else {
          if (!present) throw new PolicyError(`controller persistent ${file.action} target is missing after operations/cleanup: ${file.path}`);
          const info = await lstat(target);
          if (info.isSymbolicLink() || !info.isFile()) {
            throw new PolicyError(`controller persistent ${file.action} target is not a regular file after operations/cleanup: ${file.path}`);
          }
          record.observedSha256 = await fileDigest(target);
          if (record.observedSha256 !== file.contentSha256) {
            throw new PolicyError(`controller persistent ${file.action} target SHA-256 differs from the plan after operations/cleanup: ${file.path}`);
          }
          record.state = 'verified-exact';
        }
      } catch (error) {
        record.state = 'mismatch';
        record.reason = error.message;
        record.checkedAt = new Date().toISOString();
        await persist();
        throw error;
      }

      record.checkedAt = new Date().toISOString();
      planState.persistentVerification.verified += 1;
      await persist();
    }

    planState.persistentVerification.completedAt = new Date().toISOString();
    await persist();
  }

  async #assert(assertion, results, workspace) {
    const result = assertion.operation ? results.get(assertion.operation) : null;
    const fail = (message) => { throw new PolicyError(`controller assertion failed: ${message}`); };
    if (assertion.kind === 'exit-equals' && result.exitCode !== assertion.value) fail(`${assertion.operation} exit ${result.exitCode} != ${assertion.value}`);
    if (assertion.kind === 'exit-not-equals' && result.exitCode === assertion.value) fail(`${assertion.operation} exit unexpectedly equals ${assertion.value}`);
    if (assertion.kind === 'stdout-equals' && result.stdout !== assertion.value) fail(`${assertion.operation} stdout differs`);
    if (assertion.kind === 'stdout-contains' && !result.stdout.includes(assertion.value)) fail(`${assertion.operation} stdout missing marker`);
    if (assertion.kind === 'stderr-equals' && result.stderr !== assertion.value) fail(`${assertion.operation} stderr differs`);
    if (assertion.kind === 'stderr-contains' && !result.stderr.includes(assertion.value)) fail(`${assertion.operation} stderr missing marker`);
    if (assertion.kind === 'outputs-equal') {
      const left = results.get(assertion.leftOperation);
      const right = results.get(assertion.rightOperation);
      if (left[assertion.stream] !== right[assertion.stream]) fail(`${assertion.leftOperation}/${assertion.rightOperation} ${assertion.stream} differs`);
    }
    if (assertion.kind === 'file-exists' || assertion.kind === 'file-absent' || assertion.kind === 'file-sha256') {
      const target = await assertContainedNoFollow(workspace.worktreeDir, assertion.path);
      const present = await exists(target);
      if (assertion.kind === 'file-exists' && !present) fail(`${assertion.path} does not exist`);
      if (assertion.kind === 'file-absent' && present) fail(`${assertion.path} exists`);
      if (assertion.kind === 'file-sha256') {
        if (!present) fail(`${assertion.path} does not exist`);
        if (await fileDigest(target) !== assertion.sha256) fail(`${assertion.path} SHA-256 differs`);
      }
    }
    if (assertion.kind === 'json-field-equals') {
      let parsed;
      try { parsed = JSON.parse(result[assertion.stream]); }
      catch { fail(`${assertion.operation} ${assertion.stream} is not JSON`); }
      const located = primitiveAtPath(parsed, assertion.field);
      if (!located.found || !Object.is(located.value, assertion.value)) fail(`${assertion.operation} JSON field ${assertion.field} differs`);
    }
    if (assertion.kind === 'workspace-clean') {
      const snapshot = await this.#workspace.snapshot(workspace);
      if (snapshot.dirty) fail('workspace is dirty');
    }
  }

  async execute({ plan, state, workspace, persist, onLiveness = null }) {
    state.controllerPlan ??= {
      protocol: plan.protocol,
      phase: 'materializing',
      files: [],
      operations: [],
      cleanupLedger: [],
      scratchLedger: [],
      assertionsPassed: 0,
      startedAt: new Date().toISOString(),
    };
    state.controllerPlan.scratchLedger ??= [];
    const planState = state.controllerPlan;
    const results = new Map();
    const scratch = new ManagedScratchTransaction({
      workspace,
      state,
      persist,
      faultInjector: this.#faults,
      effectGuard: guardActiveTaskLease,
    });

    try {
      planState.phase = 'materializing';
      await persist();
      for (const file of plan.files) {
        const existing = planState.files.find((entry) => entry.path === file.path);
        if (existing?.state === 'applied') continue;
        let fileState = existing;
        if (!fileState) {
          fileState = { path: file.path, scope: file.scope, action: file.action, state: 'planned', updatedAt: new Date().toISOString() };
          planState.files.push(fileState);
          if (file.scope === 'ephemeral') {
            planState.cleanupLedger.push({ path: file.path, kind: 'file', state: 'planned', updatedAt: new Date().toISOString() });
          }
          await persist();
        }
        const applied = await this.#applyFile(file, { state, workspace });
        this.#faults?.throwIfTriggered('file.after-effect', { operation: file.path });
        fileState.state = 'applied';
        fileState.digest = applied.digest;
        fileState.reconciled = applied.reconciled === true;
        fileState.updatedAt = new Date().toISOString();
        const ledgerEntry = planState.cleanupLedger.find((entry) => entry.path === file.path);
        if (ledgerEntry) {
          ledgerEntry.state = file.action === 'reserve' ? 'planned' : 'created';
          ledgerEntry.updatedAt = new Date().toISOString();
        }
        await persist();
      }

      planState.phase = 'running-operations';
      await persist();
      for (const operation of plan.operations) {
        this.#registry.validate(operation.operation, operation.params);
        const usesEnvironmentScratch = typeof this.#registry.usesEnvironmentScratch === 'function'
          && this.#registry.usesEnvironmentScratch(operation.operation);
        if (usesEnvironmentScratch) {
          const existing = planState.environmentScratchCleanup;
          planState.environmentScratchCleanup = {
            resource: 'scratch',
            state: 'planned',
            attempts: existing?.attempts ?? 0,
            updatedAt: new Date().toISOString(),
          };
          await persist();
        }
        let record = planState.operations.find((entry) => entry.id === operation.id);
        if (!record) {
          record = { id: operation.id, operation: operation.operation, state: 'planned', attempts: 0 };
          planState.operations.push(record);
        }
        record.state = 'attempted';
        record.attempts = (record.attempts ?? 0) + 1;
        record.attemptedAt = new Date().toISOString();
        record.result = null;
        await persist();
        this.#faults?.throwIfTriggered('operation.before', { operation: operation.operation });
        const result = await this.#registry.execute(operation.operation, operation.params, {
          projectDir: workspace.worktreeDir,
          processRunner: this.#processRunner,
          scratch,
          onActivity: (activity) => onLiveness?.({ operationId: operation.id, operation: operation.operation, ...activity }),
        });
        const evidence = operationResultEvidence(operation.id, operation.operation, result);
        this.#faults?.throwIfTriggered('operation.after-effect', { operation: operation.operation });
        record.result = evidence;
        record.state = 'observed';
        record.observedAt = new Date().toISOString();
        results.set(operation.id, evidence);
        await persist();
        if (evidence.timedOut) throw new PolicyError(`deterministic operation ${operation.id} timed out`);
      }

      planState.phase = 'asserting';
      planState.assertionsPassed = 0;
      await persist();
      for (let index = 0; index < plan.assertions.length; index += 1) {
        await this.#assert(plan.assertions[index], results, workspace);
        planState.assertionsPassed = index + 1;
        await persist();
      }
    } finally {
      planState.phase = 'cleaning';
      await persist();
      let environmentCleanupError = null;
      try {
        await this.#cleanupEnvironmentScratch(planState, workspace, persist);
      } catch (error) {
        environmentCleanupError = error;
      }
      const scratchCleanup = await scratch.cleanup();
      planState.scratchCleanup = scratchCleanup;
      await persist();
      await this.#cleanup(state, workspace, persist);
      if (environmentCleanupError) throw environmentCleanupError;
    }

    // Never trust the earlier applied state after executable operations. A
    // repository-controlled test/build may have changed or recreated a planned
    // persistent path while retaining the same changed-path set.
    await this.#verifyPersistentFiles(plan, planState, workspace, persist);

    const snapshot = await this.#workspace.validate(workspace);
    const actual = [...snapshot.changedFiles].sort();
    const expected = [...plan.expectedChangedPaths].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new PolicyError(`controller plan changed-path set mismatch; expected [${expected.join(', ')}], observed [${actual.join(', ')}]`);
    }
    planState.phase = 'complete';
    planState.completedAt = new Date().toISOString();
    planState.cleanup = {
      created: planState.cleanupLedger.filter((entry) => ['created', 'removed', 'verified-absent'].includes(entry.state)).length,
      removed: planState.cleanupLedger.filter((entry) => ['removed', 'verified-absent'].includes(entry.state)).length,
      verifiedAbsent: planState.cleanupLedger.filter((entry) => entry.state === 'verified-absent').length,
      leftovers: planState.cleanupLedger.filter((entry) => entry.state !== 'verified-absent').map((entry) => entry.path),
      scratchVerifiedAbsent: planState.scratchCleanup?.verifiedAbsent ?? 0,
      scratchLeftovers: planState.scratchCleanup?.leftovers ?? [],
      environmentScratchVerifiedAbsent: planState.environmentScratchCleanup?.state === 'verified-absent',
    };
    await persist();
    return {
      snapshot,
      tests: planState.operations.map((entry) => ({
        operation: entry.operation,
        id: entry.id,
        attempts: entry.attempts ?? 1,
        exitCode: entry.result?.exitCode ?? null,
        timedOut: entry.result?.timedOut === true,
        outputTruncated: entry.result?.outputTruncated === true,
      })),
      summary: `Controller plan completed ${planState.operations.length} deterministic operations and ${planState.assertionsPassed} assertions; reverified ${planState.persistentVerification.verified}/${planState.persistentVerification.required} persistent file proposals; cleanup verified ${planState.cleanup.verifiedAbsent}/${planState.cleanupLedger.length} ephemeral paths and ${planState.cleanup.scratchVerifiedAbsent}/${planState.scratchLedger.length} host scratch directories absent; environment scratch ${planState.cleanup.environmentScratchVerifiedAbsent ? 'verified absent' : 'not used'}.`,
    };
  }
}
