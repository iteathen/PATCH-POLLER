import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { ProjectRelativePathError, normalizeProjectRelativePath } from '../values/project-relative-path.js';
import { deterministicOperationSecurity } from './deterministic-operation-security.js';
import { createCoreToolchainRegistry } from './toolchain-registry.js';

const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/u;
const SAFE_TARGET = /^[A-Za-z0-9_.:+-]{1,120}$/u;
const BUILD_TYPES = new Set(['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel']);
const ARCHITECTURES = new Set(['x64', 'Win32', 'ARM64']);

function objectParams(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError(`${operation} params must be an object`);
  return value;
}
function onlyKeys(value, allowed, operation) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PolicyError(`${operation} parameter ${key} is not allowed`);
}
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function policyPath(value, name) {
  try {
    return normalizeProjectRelativePath(value);
  } catch (error) {
    if (!(error instanceof ProjectRelativePathError)) throw error;
    throw new PolicyError(`${name} ${error.message}`, { cause: error });
  }
}
function projectPath(projectDir, relative, name) {
  const safe = policyPath(relative, name);
  const resolved = path.resolve(projectDir, safe);
  const rel = path.relative(path.resolve(projectDir), resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PolicyError(`${name} escaped project root`);
  return { safe, resolved };
}
async function assertStaticProjectPathNoFollow(projectDir, relative, name) {
  const target = projectPath(projectDir, relative, name);
  const root = path.resolve(projectDir);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new PolicyError(`${name} project root must be a real directory`);
  const rootReal = await realpath(root);
  const rel = path.relative(root, target.resolved);
  let cursor = root;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new PolicyError(`${name} crosses filesystem indirection`);
    const canonical = await realpath(cursor);
    if (!isWithin(rootReal, canonical)) throw new PolicyError(`${name} resolves outside project root`);
  }
  return target;
}
function localEnvironment() {
  const pass = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'];
  return { pass, set: { CI: '1' } };
}
function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new PolicyError(`${name} must be a safe identifier`);
  return value;
}
function safeBuildType(value, name) {
  if (value == null) return null;
  if (!BUILD_TYPES.has(value)) throw new PolicyError(`${name} is unsupported`);
  return value;
}
function safeGenerator(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 120 || value.startsWith('-') || !/^[A-Za-z0-9 ._+()/-]+$/u.test(value)) {
    throw new PolicyError('cmake.configure generator is invalid');
  }
  return value;
}
function safeArchitecture(value) {
  if (value == null) return null;
  if (!ARCHITECTURES.has(value)) throw new PolicyError('cmake.configure architecture is unsupported');
  return value;
}
function safeTarget(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !SAFE_TARGET.test(value)) throw new PolicyError('cmake.build target is invalid');
  return value;
}
function observedResult(stdout, stderr = '', exitCode = 0) {
  const now = new Date().toISOString();
  return { exitCode, signal: null, timedOut: false, outputTruncated: false, stdout, stderr, startedAt: now, finishedAt: now, lastOutputAt: stdout || stderr ? now : null };
}
function executionScratch(buildId) { return { kind: 'scratch', name: `cmake-${buildId}` }; }

function scopedProcessRunner(processRunner, security, context) {
  if (!processRunner || typeof processRunner.run !== 'function') return processRunner;
  return {
    run(request) {
      return processRunner.run({
        ...request,
        executionClass: security.executionClass,
        repository: context.repository ?? null,
        repositoryId: context.repositoryId ?? null,
        runId: context.runId ?? null,
      });
    },
  };
}

export class DeterministicOperationRegistry {
  #operations = new Map();
  register(name, adapter) {
    if (!SAFE_ID.test(name)) throw new PolicyError('registered operation name is invalid');
    if (this.#operations.has(name)) throw new PolicyError(`registered operation ${name} already exists`);
    if (!adapter || typeof adapter.validate !== 'function' || typeof adapter.execute !== 'function') {
      throw new PolicyError(`registered operation ${name} must provide validate and execute`);
    }
    this.#operations.set(name, adapter);
    return this;
  }
  has(name) { return this.#operations.has(name); }
  names() { return [...this.#operations.keys()].sort(); }
  executionClass(name) {
    if (!this.#operations.has(name)) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    return deterministicOperationSecurity(name).executionClass;
  }
  usesEnvironmentScratch(name) {
    const adapter = this.#operations.get(name);
    if (!adapter) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    return adapter.environmentScratch === true;
  }
  describe() {
    return this.names().map((name) => {
      const adapter = this.#operations.get(name);
      const description = { name, layer: adapter.layer ?? 'core' };
      if (adapter.publicSchema) description.parameterSchema = structuredClone(adapter.publicSchema);
      return description;
    });
  }
  validate(name, params) {
    const adapter = this.#operations.get(name);
    if (!adapter) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    return adapter.validate(params);
  }
  async execute(name, params, context) {
    const adapter = this.#operations.get(name);
    if (!adapter) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    const validated = adapter.validate(params);
    const security = deterministicOperationSecurity(name);
    const securedContext = context && context.processRunner
      ? { ...context, processRunner: scopedProcessRunner(context.processRunner, security, context) }
      : context;
    return adapter.execute(validated, securedContext);
  }
}

function nodeScriptAdapter({ mode }) {
  return {
    layer: 'core',
    validate(raw) {
      const params = objectParams(raw, mode);
      const allowed = mode === 'node.test' ? new Set(['paths']) : new Set(['path']);
      onlyKeys(params, allowed, mode);
      if (mode === 'node.test') {
        if (!Array.isArray(params.paths) || params.paths.length === 0 || params.paths.length > 32) throw new PolicyError('node.test paths must contain 1-32 project-relative paths');
        return { paths: params.paths.map((value, index) => policyPath(value, `node.test.paths[${index}]`)) };
      }
      return { path: policyPath(params.path, `${mode}.path`) };
    },
    async execute(params, { projectDir, processRunner, onActivity }) {
      if (mode === 'node.test') {
        for (const relative of params.paths) await access(projectPath(projectDir, relative, 'node.test path').resolved);
        return processRunner.run({
          args: ['--test', ...params.paths],
          cwd: projectDir,
          timeoutMs: 180_000,
          maxOutputBytes: 1024 * 1024,
          environment: { pass: [], set: { CI: '1' } },
          onActivity,
          operation: mode,
          repositoryTool: 'node',
          repositoryWorkingDirectory: '.',
        });
      }
      const checked = await assertStaticProjectPathNoFollow(projectDir, params.path, `${mode} path`);
      return processRunner.run({
        executable: process.execPath,
        args: ['--check', checked.safe],
        cwd: projectDir,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        environment: localEnvironment(),
        onActivity,
        operation: mode,
      });
    },
  };
}

function toolchainProbeAdapter(toolchains) {
  return {
    layer: 'core',
    validate(raw) {
      const params = objectParams(raw, 'toolchain.probe');
      onlyKeys(params, new Set(['name']), 'toolchain.probe');
      const name = safeId(params.name, 'toolchain.probe name');
      if (!toolchains.has(name)) throw new PolicyError(`toolchain.probe references unregistered local toolchain ${name}`);
      return { name };
    },
    async execute(params) {
      try {
        const descriptor = await toolchains.resolve(params.name, { refresh: true });
        return observedResult(`${JSON.stringify({ name: descriptor.name, family: descriptor.family ?? null, version: descriptor.version ?? null, source: descriptor.source ?? null, available: true })}\n`);
      } catch (error) {
        return observedResult('', `${error.name}: ${error.message}\n`, 127);
      }
    },
  };
}

function cmakeConfigureAdapter() {
  return {
    layer: 'core',
    environmentScratch: true,
    validate(raw) {
      const params = objectParams(raw, 'cmake.configure');
      onlyKeys(params, new Set(['sourcePath', 'buildId', 'buildType', 'generator', 'architecture']), 'cmake.configure');
      return {
        sourcePath: policyPath(params.sourcePath ?? 'CMakeLists.txt', 'cmake.configure sourcePath'),
        buildId: safeId(params.buildId, 'cmake.configure buildId'),
        buildType: safeBuildType(params.buildType, 'cmake.configure buildType'),
        generator: safeGenerator(params.generator),
        architecture: safeArchitecture(params.architecture),
      };
    },
    async execute(params, { projectDir, processRunner, onActivity }) {
      const source = projectPath(projectDir, params.sourcePath, 'cmake.configure sourcePath');
      const sourceInfo = path.basename(source.safe).toLowerCase() === 'cmakelists.txt' ? path.dirname(source.safe) || '.' : source.safe;
      const args = ['-S', sourceInfo, '-B', executionScratch(params.buildId)];
      if (params.generator) args.push('-G', params.generator);
      if (params.architecture) args.push('-A', params.architecture);
      if (params.buildType) args.push(`-DCMAKE_BUILD_TYPE=${params.buildType}`);
      return processRunner.run({
        args,
        cwd: projectDir,
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        environment: { pass: [], set: { CI: '1' } },
        onActivity,
        operation: 'cmake.configure',
        repositoryTool: 'cmake',
        repositoryWorkingDirectory: '.',
      });
    },
  };
}

function cmakeBuildAdapter() {
  return {
    layer: 'core',
    environmentScratch: true,
    validate(raw) {
      const params = objectParams(raw, 'cmake.build');
      onlyKeys(params, new Set(['buildId', 'config', 'target']), 'cmake.build');
      return { buildId: safeId(params.buildId, 'cmake.build buildId'), config: safeBuildType(params.config, 'cmake.build config'), target: safeTarget(params.target) };
    },
    async execute(params, { projectDir, processRunner, onActivity }) {
      const args = ['--build', executionScratch(params.buildId)];
      if (params.config) args.push('--config', params.config);
      if (params.target) args.push('--target', params.target);
      return processRunner.run({
        args,
        cwd: projectDir,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        environment: { pass: [], set: { CI: '1' } },
        onActivity,
        operation: 'cmake.build',
        repositoryTool: 'cmake',
        repositoryWorkingDirectory: '.',
      });
    },
  };
}

function ctestAdapter() {
  return {
    layer: 'core',
    environmentScratch: true,
    validate(raw) {
      const params = objectParams(raw, 'ctest.run');
      onlyKeys(params, new Set(['buildId', 'config']), 'ctest.run');
      return { buildId: safeId(params.buildId, 'ctest.run buildId'), config: safeBuildType(params.config, 'ctest.run config') };
    },
    async execute(params, { projectDir, processRunner, onActivity }) {
      const args = ['--test-dir', executionScratch(params.buildId), '--output-on-failure'];
      if (params.config) args.push('-C', params.config);
      return processRunner.run({
        args,
        cwd: projectDir,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        environment: { pass: [], set: { CI: '1' } },
        onActivity,
        operation: 'ctest.run',
        repositoryTool: 'ctest',
        repositoryWorkingDirectory: '.',
      });
    },
  };
}

export function createCoreOperationRegistry({ toolchainRegistry = null } = {}) {
  const toolchains = toolchainRegistry ?? createCoreToolchainRegistry();
  return new DeterministicOperationRegistry()
    .register('node.syntax-check', nodeScriptAdapter({ mode: 'node.syntax-check' }))
    .register('node.test', nodeScriptAdapter({ mode: 'node.test' }))
    .register('toolchain.probe', toolchainProbeAdapter(toolchains))
    .register('cmake.configure', cmakeConfigureAdapter())
    .register('cmake.build', cmakeBuildAdapter())
    .register('ctest.run', ctestAdapter());
}
