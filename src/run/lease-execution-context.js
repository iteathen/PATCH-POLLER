import { AsyncLocalStorage } from 'node:async_hooks';

const activeTaskLease = new AsyncLocalStorage();

export async function guardActiveTaskLease({ refresh = false } = {}) {
  const active = activeTaskLease.getStore() ?? null;
  if (!active) return null;
  active.manager.assertOwned(active.handle);
  if (refresh) {
    if (typeof active.manager.ensureFresh === 'function') await active.manager.ensureFresh(active.handle);
    else await active.manager.renew(active.handle);
    active.manager.assertOwned(active.handle);
  }
  return active.handle;
}

export class LeaseExecutionContext {
  #manager;

  constructor({ taskLeaseManager }) {
    if (!taskLeaseManager || typeof taskLeaseManager.assertOwned !== 'function') throw new TypeError('LeaseExecutionContext requires a task lease manager');
    this.#manager = taskLeaseManager;
  }

  run(handle, callback) {
    this.#manager.assertOwned(handle);
    return activeTaskLease.run({ manager: this.#manager, handle }, callback);
  }

  #active() {
    const active = activeTaskLease.getStore() ?? null;
    if (!active) return null;
    active.manager.assertOwned(active.handle);
    return active.handle;
  }

  async #freshSensitiveLease() {
    return guardActiveTaskLease({ refresh: true });
  }

  wrapProcessRunner(delegate) {
    if (!delegate || typeof delegate.run !== 'function') throw new TypeError('lease process wrapper requires a process runner');
    return {
      run: async (request) => {
        const handle = this.#active();
        const result = await delegate.run(handle ? { ...request, signal: handle.signal } : request);
        if (handle) await guardActiveTaskLease();
        return result;
      },
      cleanup: typeof delegate.cleanup === 'function'
        ? async (request) => {
            const handle = this.#active();
            const result = await delegate.cleanup(handle ? { ...request, signal: handle.signal } : request);
            if (handle) await guardActiveTaskLease();
            return result;
          }
        : undefined,
      recoverResult: typeof delegate.recoverResult === 'function'
        ? async (request) => {
            const handle = this.#active();
            const result = await delegate.recoverResult(request);
            if (handle) await guardActiveTaskLease();
            return result;
          }
        : undefined,
    };
  }

  wrapWorkspaceManager(delegate) {
    if (!delegate || typeof delegate.prepareRun !== 'function') throw new TypeError('lease workspace wrapper requires a workspace manager');
    const guarded = async (method, args, { refresh = false } = {}) => {
      const handle = refresh ? await this.#freshSensitiveLease() : this.#active();
      const result = await delegate[method](...args);
      if (handle) await guardActiveTaskLease();
      return result;
    };
    return {
      prepareRun: (...args) => guarded('prepareRun', args),
      snapshot: (...args) => guarded('snapshot', args),
      validate: (...args) => guarded('validate', args),
      sealCandidate: (...args) => guarded('sealCandidate', args, { refresh: true }),
      publishTaskBranch: (...args) => guarded('publishTaskBranch', args, { refresh: true }),
    };
  }
}