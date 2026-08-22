import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentConstructionWorkspaces } from '../src/app/environment-construction-workspaces.js';
import { executionProfileSubject, executionWorkspaceIdentity } from '../src/app/execution-profile-routing.js';
import { loadEnvironmentExecutionRoutes } from '../src/app/repository-execution.js';

function stateFor(profile) {
  const physical = {
    record: { identity: 'env-0123456789abcdef0123456789abcdef', subject: executionProfileSubject(profile), profile },
    observation: { exists: true, owned: true, compatible: true },
  };
  return {
    inspect: async () => ({ ready: true }),
    listEnvironments: async () => [structuredClone(physical)],
    observeEnvironment: async () => structuredClone(physical),
  };
}

function channel(events) {
  return {
    health: async (target) => { events.push(['health', target]); return { ready: true }; },
    put: async (target, _source, destination) => { events.push(['put', target, destination]); return { transferred: true }; },
    get: async () => { throw new Error('unexpected get'); },
    execute: async (target, operation) => { events.push(['execute', target, operation]); return { completion: 'observed', result: { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: 'ready', stderr: '' } }; },
  };
}

test('construction workspaces publish exact routes and prepare scoped roots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const events = [];
    const port = createEnvironmentConstructionWorkspaces({
      stateDirectory: directory,
      state: stateFor(profile),
      channel: channel(events),
      resolveAuthority: async (authority) => { assert.equal(authority, 'authority-a'); return subject; },
      resolveAccess: async () => ({ family: 'linux', user: 'devbridge', identityFile: '/host/identity', knownHostsFile: '/host/known-hosts' }),
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    const result = await port.ensure(request);
    assert.equal(result.ready, true);
    assert.equal(result.routesChanged, true);
    const policy = await loadEnvironmentExecutionRoutes(directory);
    assert.deepEqual(policy.routes, [{
      subject,
      profile,
      preferred: false,
      validation: false,
      access: { family: 'linux', user: 'devbridge', identityFile: '/host/identity', knownHostsFile: '/host/known-hosts' },
    }]);
    const scopedPut = events.find((entry) => entry[0] === 'put');
    assert.match(scopedPut[2].path, new RegExp(`^workspaces/${workspace.identity}/lifecycle/ready$`, 'u'));
    const scopedExecute = events.find((entry) => entry[0] === 'execute');
    assert.equal(scopedExecute[2].directory.path, `workspaces/${workspace.identity}`);
    assert.equal((await port.inspect(request)).ready, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('construction workspaces may resolve a request-scoped channel without persisting transport topology', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    let resolved = 0;
    const port = createEnvironmentConstructionWorkspaces({
      stateDirectory: directory,
      state: stateFor(profile),
      resolveChannel: async ({ declaration: selected }) => { assert.equal(selected, declaration); resolved += 1; return channel([]); },
      resolveAuthority: async () => subject,
      resolveAccess: async () => ({ family: 'linux', user: 'devbridge', identityFile: '/host/identity', knownHostsFile: '/host/known-hosts' }),
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    assert.equal((await port.ensure(request)).ready, true);
    assert.equal(resolved, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('construction workspaces refuse identity or access authority drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    let access = { family: 'linux', user: 'devbridge', identityFile: '/host/identity', knownHostsFile: '/host/known-hosts' };
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const port = createEnvironmentConstructionWorkspaces({
      stateDirectory: directory,
      state: stateFor(profile),
      channel: channel([]),
      resolveAuthority: async () => subject,
      resolveAccess: async () => access,
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    await port.ensure(request);
    access = { ...access, identityFile: '/host/other-identity' };
    await assert.rejects(() => port.ensure(request), /access changed/u);
    const wrong = { declaration: { ...declaration, workspaces: [{ ...workspace, identity: 'workspace-wrong' }] }, implementationGeneration: request.implementationGeneration };
    await assert.rejects(() => port.ensure(wrong), /does not match host authority/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
