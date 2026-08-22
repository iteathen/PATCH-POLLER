import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  preflightExecutionProfileMemory,
  preflightExecutionProfileStoragePaths,
} from '../profile-resource-preflight.js';
import { HyperVPersistentEnvironment as PersistentEnvironmentCore } from './hyperv-persistent-environment-core.js';

async function canonicalRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('environment source root is invalid');
  const lexical = path.resolve(value);
  let info;
  try { info = await lstat(lexical); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('environment source root is unavailable');
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment source root must be a real directory');
  return realpath(lexical);
}

export class HyperVPersistentEnvironment {
  #options;
  #delegate = null;

  constructor(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('environment adapter options must be an object');
    new PersistentEnvironmentCore(options);
    this.#options = { ...options };
  }

  async inspect() {
    return new PersistentEnvironmentCore(this.#options).inspect();
  }

  async #core() {
    if (!this.#delegate) {
      const sourceRoot = await canonicalRoot(this.#options.sourceRoot);
      this.#delegate = new PersistentEnvironmentCore({ ...this.#options, sourceRoot });
    }
    return this.#delegate;
  }

  async provision(input) {
    preflightExecutionProfileMemory(input?.settings);
    await preflightExecutionProfileStoragePaths({
      directory: this.#options.directory,
      sourceLocation: input?.source?.handle?.location,
    });
    return (await this.#core()).provision(input);
  }
  async observe(identity) { return (await this.#core()).observe(identity); }
  async start(identity) { return (await this.#core()).start(identity); }
  async stop(identity, options) { return (await this.#core()).stop(identity, options); }
  async drop(identity) { return (await this.#core()).drop(identity); }
}
