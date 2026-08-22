import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfigurationDiscovery } from '../src/bootstrap/configuration-discovery.mjs';
import { configureLocalConfig } from '../src/bootstrap/runtime-bootstrap.mjs';
import { setupEnvironments } from '../src/bootstrap/environment-setup.mjs';
import { executionProfileSubject } from '../src/app/execution-profile-routing.js';
import { recordInstallEntries, readInstallManifest } from '../src/bootstrap/install-manifest.mjs';
import { uninstall } from '../src/bootstrap/uninstall.mjs';

function outputPort() {
  let text = '';
  return { isTTY: false, write(value) { text += String(value); }, get text() { return text; } };
}

function interactivePorts(answers) {
  const input = { isTTY: true };
  const output = outputPort();
  output.isTTY = true;
  const remaining = answers.slice();
  const promptFactory = () => ({
    async question(message) {
      output.write(message);
      if (remaining.length < 1) throw new Error('scripted prompt has no remaining answer');
      return remaining.shift();
    },
    close() {},
  });
  return { input, output, promptFactory, get text() { return output.text; } };
}

test('setup discovery lists authenticated repositories before bounded task-author candidates', async () => {
  const calls = [];
  const client = {
    async request(_method, requestPath) {
      calls.push(requestPath);
      if (requestPath.startsWith('/user/repos?')) return {
        data: [
          { id: 1, full_name: 'owner/one', has_issues: true, permissions: { push: true } },
          { id: 2, full_name: 'owner/archived', has_issues: true, archived: true },
          { id: 3, full_name: 'owner/no-issues', has_issues: false },
        ],
        headers: new Headers(),
      };
      if (requestPath === '/user') return { data: { id: 10, login: 'operator' }, headers: new Headers() };
      if (requestPath === '/repos/owner/custom') return { data: { id: 4, full_name: 'Owner/Custom', has_issues: true, permissions: { pull: true } }, headers: new Headers() };
      if (requestPath === '/users/custom-user') return { data: { id: 12, login: 'Custom-User' }, headers: new Headers() };
      if (requestPath === '/user/12') return { data: { id: 12, login: 'Custom-User' }, headers: new Headers() };
      if (requestPath.startsWith('/repos/owner/one/collaborators?')) return {
        data: [{ id: 10, login: 'operator' }, { id: 11, login: 'worker' }],
        headers: new Headers(),
      };
      throw new Error(`unexpected request ${requestPath}`);
    },
  };
  const discovery = await createConfigurationDiscovery({}, {
    sessionFactory: async () => ({ client, credential: { provider: 'fixture', source: 'fixture' } }),
  });
  const repositories = await discovery.listRepositories();
  assert.deepEqual(repositories.records.map((entry) => entry.name), ['owner/one']);
  const authors = await discovery.listAuthors(['owner/one']);
  assert.deepEqual(authors.records.map((entry) => [entry.login, entry.id]), [['operator', '10'], ['worker', '11']]);
  assert.deepEqual(authors.authenticatedUser, { login: 'operator', id: '10' });
  assert.equal((await discovery.resolveRepository('owner/custom')).name, 'Owner/Custom');
  assert.equal((await discovery.resolveAuthor('custom-user')).id, '12');
  assert.equal((await discovery.resolveAuthorId('12')).login, 'Custom-User');
  assert.equal(calls[0].startsWith('/user/repos?'), true);
  assert.equal(calls[1], '/user');
});

test('custom repository and actor entries are rejected when GitHub returns a different identity', async () => {
  const discovery = await createConfigurationDiscovery({}, {
    sessionFactory: async () => ({
      credential: { provider: 'fixture', source: 'fixture' },
      client: {
        async request(_method, requestPath) {
          if (requestPath.startsWith('/repos/')) return { data: { id: 9, full_name: 'other/repository', has_issues: true } };
          if (requestPath.startsWith('/users/')) return { data: { id: 10, login: 'different-user' } };
          if (requestPath.startsWith('/user/')) return { data: { id: 11, login: 'actor' } };
          throw new Error(`unexpected request ${requestPath}`);
        },
      },
    }),
  });
  await assert.rejects(discovery.resolveRepository('owner/repository'), /exact repository identity/u);
  await assert.rejects(discovery.resolveAuthor('requested-user'), /exact actor login/u);
  await assert.rejects(discovery.resolveAuthorId('10'), /exact actor ID/u);
});

test('noninteractive setup reports discovered choices before changing configuration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-setup-discovery-'));
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({
    version: 1,
    github: { queueRepositories: ['owner/one'], repositoryDiscovery: { enabled: false }, trustedActorIds: ['10'] },
    workspace: { allowedOwners: ['owner'] },
  }, null, 2)}\n`);
  const output = outputPort();
  const discovery = {
    async listRepositories() { return { records: [{ name: 'owner/one', id: '1', private: false }], truncated: false }; },
    async listAuthors() { return { records: [{ login: 'operator', id: '10', repositories: [] }], warnings: [], truncated: false }; },
  };
  const result = await configureLocalConfig({ config: configFile }, ['setup'], { input: { isTTY: false }, output, discovery });
  assert.equal(result.completed, false);
  const report = JSON.parse(output.text);
  assert.deepEqual(report.discoveredRepositories.map((entry) => entry.name), ['owner/one']);
  assert.deepEqual(report.discoveredTaskAuthors.map((entry) => entry.id), ['10']);
});

test('scripted setup selects multiple repositories and task authors without a prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-setup-scripted-'));
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({
    version: 1,
    github: { queueRepositories: ['owner/one'], repositoryDiscovery: { enabled: false }, trustedActorIds: ['10'] },
    workspace: { allowedOwners: ['owner'] },
  }, null, 2)}\n`);
  const result = await configureLocalConfig(
    { config: configFile },
    ['setup', '--repository', 'owner/one', '--repository', 'second/two', '--trusted-author', '10', '--trusted-author', '11', '--repository-discovery', '--no-environments', '--confirm', 'APPLY'],
    {
      input: { isTTY: false },
      output: outputPort(),
      discovery: {
        async listRepositories() { return { records: [{ name: 'owner/one', id: '1', private: false }], truncated: false }; },
        async resolveRepository(name) { assert.equal(name, 'second/two'); return { name, id: '2', private: false }; },
        async listAuthors() { return { records: [], authenticatedUser: null, warnings: [], truncated: false }; },
        async resolveAuthorId(id) { return { id, login: `actor-${id}` }; },
      },
    },
  );
  assert.equal(result.completed, true);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(config.github.queueRepositories, ['owner/one', 'second/two']);
  assert.deepEqual(config.github.trustedActorIds, ['10', '11']);
  assert.equal(config.github.repositoryDiscovery.enabled, true);
  assert.deepEqual(config.workspace.allowedOwners, ['owner', 'second']);
});

test('scripted authority changes warn and decline to write without exact APPLY confirmation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-setup-unconfirmed-'));
  const configFile = path.join(root, 'config.json');
  const original = `${JSON.stringify({
    version: 1,
    github: { queueRepositories: ['owner/one'], repositoryDiscovery: { enabled: false }, trustedActorIds: ['10'] },
    workspace: { allowedOwners: ['owner'] },
  }, null, 2)}\n`;
  writeFileSync(configFile, original);
  const output = outputPort();
  await assert.rejects(
    configureLocalConfig(
      { config: configFile },
      ['setup', '--repository', 'custom/repository'],
      {
        input: { isTTY: false },
        output,
        discovery: {
          async listRepositories() { return { records: [], truncated: false }; },
          async resolveRepository() { return { name: 'custom/repository', id: '22', private: true }; },
        },
      },
    ),
    /exact --confirm APPLY/u,
  );
  assert.match(output.text, /WARNING: repository selections grant polling scope/u);
  assert.match(output.text, /verified-repository=custom\/repository github-id=22/u);
  assert.equal(readFileSync(configFile, 'utf8'), original);
});

test('interactive setup retries invalid input, verifies custom identities, supports all/self/names, and requires exact confirmation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-setup-interactive-'));
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({
    version: 1,
    github: { queueRepositories: ['owner/one'], repositoryDiscovery: { enabled: false }, trustedActorIds: ['10'] },
    workspace: { allowedOwners: ['owner'] },
  }, null, 2)}\n`);
  const ports = interactivePorts([
    '99',
    'all custom/repo',
    'maybe',
    'no',
    'unknown-user',
    'self worker custom-user',
    'NO',
    '1 2 custom/repo',
    'no',
    'self worker custom-user',
    'APPLY',
  ]);
  const discovery = {
    async listRepositories() {
      return {
        records: [
          { name: 'owner/one', id: '1', private: false },
          { name: 'owner/two', id: '2', private: false },
        ],
        truncated: false,
      };
    },
    async resolveRepository(name) {
      assert.equal(name, 'custom/repo');
      return { name: 'custom/repo', id: '3', private: true };
    },
    async listAuthors(repositories) {
      assert.deepEqual(repositories, ['owner/one', 'owner/two', 'custom/repo']);
      return {
        records: [
          { login: 'operator', id: '10', repositories: repositories.slice() },
          { login: 'worker', id: '11', repositories: ['owner/two'] },
        ],
        authenticatedUser: { login: 'operator', id: '10' },
        warnings: [],
        truncated: false,
      };
    },
    async resolveAuthor(login) {
      if (login === 'unknown-user') throw new Error('GitHub returned 404');
      assert.equal(login, 'custom-user');
      return { login: 'custom-user', id: '12', repositories: [] };
    },
    async resolveAuthorId(id) { return { id, login: `actor-${id}` }; },
  };

  const result = await configureLocalConfig({ config: configFile }, ['setup'], { ...ports, discovery });
  assert.equal(result.completed, true);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(config.github.queueRepositories, ['owner/one', 'owner/two', 'custom/repo']);
  assert.deepEqual(config.github.trustedActorIds, ['10', '11', '12']);
  assert.match(ports.text, /Invalid repository selection/u);
  assert.match(ports.text, /Invalid repository discovery selection/u);
  assert.match(ports.text, /GitHub could not verify actor login unknown-user/u);
  assert.match(ports.text, /WARNING: These repositories will be polled/u);
  assert.match(ports.text, /Selections were not applied; returning/u);
  assert.equal([...ports.text.matchAll(/Type APPLY/gu)].length, 2);
});

test('environment setup provisions only explicitly selected discovered repository identities', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-environment-setup-'));
  const state = path.join(root, 'state');
  const foundationRoot = path.join(state, 'environment-foundation');
  mkdirSync(foundationRoot, { recursive: true });
  const routesFile = path.join(foundationRoot, 'execution-routes.json');
  writeFileSync(routesFile, `${JSON.stringify({
    protocol: 'devbridge/environment-execution-routes-v1',
    routes: [{
      subject: '99', profile: 'linux-development', preferred: true, validation: true,
      access: { family: 'linux', user: 'devbridge', identityFile: path.join(root, 'identity'), knownHostsFile: path.join(root, 'known-hosts') },
    }],
  })}\n`);
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ execution: { enabled: false } }, null, 2)}\n`);
  const config = {
    __file: configFile,
    state: { directory: state },
    github: { queueRepositories: ['owner/one'] },
  };
  let created = false;
  const profileSubject = executionProfileSubject('linux-development');
  const foundation = {
    async inspect() { return { ready: true, state: 'ready' }; },
    async listImages() { return [{ identity: 'img-' + 'a'.repeat(32), profile: 'linux-development', retiredAt: null }]; },
    async listEnvironments() {
      return created ? [{ record: { identity: 'env-' + 'b'.repeat(32), subject: profileSubject, profile: 'linux-development' }, observation: { exists: true, owned: true, compatible: true, state: 'running' } }] : [];
    },
  };
  const provisioned = [];
  const result = await setupEnvironments(
    config,
    [{ name: 'owner/one', id: '1' }],
    ['setup', '--environment', 'owner/one', '--enable-execution'],
    {
      input: { isTTY: false },
      output: outputPort(),
      platform: 'win32',
      foundationFactory: async () => foundation,
      provisionFn: async (request) => {
        provisioned.push(request);
        const current = JSON.parse(readFileSync(routesFile, 'utf8'));
        current.routes.push({
          subject: '1',
          profile: 'linux-development',
          preferred: true,
          validation: false,
          access: current.routes[0].access,
        });
        writeFileSync(routesFile, `${JSON.stringify(current)}\n`);
        created = true;
        return {};
      },
    },
  );
  assert.equal(result.completed, true);
  assert.equal(provisioned[0].subject, '1');
  assert.equal(result.managedProfiles[0].subject, profileSubject);
  assert.equal(result.managedEnvironments[0].identity, 'env-' + 'b'.repeat(32));
  assert.equal(result.managedWorkspaces[0].subject, '1');
  const updated = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(updated.execution.fastVmDefaultSwitch, true);
  assert.equal(updated.execution.enabled, true);
});

test('interactive environment setup retries invalid selections instead of exiting', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-environment-interactive-'));
  const state = path.join(root, 'state');
  const foundationRoot = path.join(state, 'environment-foundation');
  mkdirSync(foundationRoot, { recursive: true });
  const access = {
    family: 'linux', user: 'devbridge',
    identityFile: path.join(root, 'identity'), knownHostsFile: path.join(root, 'known-hosts'),
  };
  writeFileSync(path.join(foundationRoot, 'execution-routes.json'), `${JSON.stringify({
    protocol: 'devbridge/environment-execution-routes-v1',
    routes: [
      { subject: '99', profile: 'linux-development', preferred: true, validation: true, access },
      { subject: '1', profile: 'linux-development', preferred: true, validation: false, access },
    ],
  })}\n`);
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ execution: { enabled: false } }, null, 2)}\n`);
  const config = {
    __file: configFile,
    state: { directory: state },
    github: { queueRepositories: ['owner/one'] },
  };
  const foundation = {
    async inspect() { return { ready: true, state: 'ready' }; },
    async listImages() { return [{ identity: 'img-' + 'a'.repeat(32), profile: 'linux-development', retiredAt: null }]; },
    async listEnvironments() {
      return [{
        record: { identity: 'env-' + 'b'.repeat(32), subject: executionProfileSubject('linux-development'), profile: 'linux-development' },
        observation: { exists: true, owned: true, compatible: true, state: 'running' },
      }];
    },
  };
  const ports = interactivePorts(['9', '1', 'maybe', 'yes']);
  const result = await setupEnvironments(config, [{ name: 'owner/one', id: '1' }], ['setup'], {
    ...ports,
    platform: 'win32',
    foundationFactory: async () => foundation,
  });
  assert.equal(result.completed, true);
  assert.deepEqual(result.selected, ['owner/one']);
  assert.match(ports.text, /Invalid workspace selection/u);
  assert.match(ports.text, /Invalid execution selection/u);
  const updated = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(updated.execution.fastVmDefaultSwitch, true);
  assert.equal(updated.execution.enabled, true);
});

test('Windows environment setup invokes only the bounded network-elevation seam with exact prescribed consent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-environment-elevation-'));
  const state = path.join(root, 'state');
  const foundationRoot = path.join(state, 'environment-foundation');
  mkdirSync(foundationRoot, { recursive: true });
  const access = {
    family: 'linux', user: 'devbridge',
    identityFile: path.join(root, 'identity'), knownHostsFile: path.join(root, 'known-hosts'),
  };
  writeFileSync(path.join(foundationRoot, 'execution-routes.json'), `${JSON.stringify({
    protocol: 'devbridge/environment-execution-routes-v1',
    routes: [
      { subject: '99', profile: 'linux-development', preferred: true, validation: true, access },
      { subject: '1', profile: 'linux-development', preferred: true, validation: false, access },
    ],
  })}\n`);
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ execution: { enabled: false } }, null, 2)}\n`);
  const config = { __file: configFile, state: { directory: state }, github: { queueRepositories: ['owner/one'] } };
  let networkingReady = false;
  const foundation = {
    async inspect() {
      return {
        identity: 'f'.repeat(32), ready: networkingReady, state: networkingReady ? 'ready' : 'degraded',
        capabilities: {
          management: { ready: true, state: 'ready', reason: null },
          networking: { ready: networkingReady, state: networkingReady ? 'ready' : 'degraded', reason: networkingReady ? null : 'owned network is absent' },
        },
      };
    },
    async listImages() { return [{ identity: 'img-' + 'a'.repeat(32), profile: 'linux-development', retiredAt: null }]; },
    async listEnvironments() {
      return [{
        record: { identity: 'env-' + 'b'.repeat(32), subject: executionProfileSubject('linux-development'), profile: 'linux-development' },
        observation: { exists: true, owned: true, compatible: true, state: 'running' },
      }];
    },
  };
  let elevationRequest = null;
  const result = await setupEnvironments(
    config,
    [{ name: 'owner/one', id: '1' }],
    ['setup', '--environment', 'owner/one', '--enable-execution', '--allow-provider-elevation', '--confirm', 'APPLY'],
    {
      input: { isTTY: false },
      output: outputPort(),
      platform: 'win32',
      foundationFactory: async () => foundation,
      networkSetupFn: async (request) => {
        elevationRequest = request;
        networkingReady = true;
        return { ready: true, changed: true };
      },
    },
  );
  assert.equal(result.completed, true);
  assert.equal(elevationRequest.foundation, foundation);
  assert.equal(elevationRequest.stateDirectory, state);
  assert.equal(elevationRequest.allowElevation, true);
});

test('install manifest is the uninstall path allowlist and app-only preserves config/state', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-uninstall-'));
  const runtime = path.join(home, 'runtime');
  const config = path.join(home, 'config.json');
  const state = path.join(home, 'state');
  mkdirSync(runtime);
  mkdirSync(state);
  writeFileSync(config, '{}\n');
  const paths = { home, installManifest: path.join(home, 'install-manifest.json') };
  await recordInstallEntries(paths, [
    { kind: 'path', role: 'runtime', path: runtime, ownership: 'created' },
    { kind: 'path', role: 'config', path: config, ownership: 'created' },
    { kind: 'path', role: 'state', path: state, ownership: 'created' },
  ]);
  assert.equal((await readInstallManifest(paths)).entries.length, 3);
  let scheduled = null;
  let pruned = null;
  const result = await uninstall(paths, ['uninstall', '--app-only', '--confirm', 'REMOVE'], {
    input: { isTTY: false },
    output: outputPort(),
    scheduleFn: (targets, options) => { scheduled = targets; pruned = options.prune; },
  });
  assert.equal(result.mode, 'app-only');
  assert.deepEqual(scheduled, [runtime]);
  assert.equal(scheduled.includes(config), false);
  assert.equal(scheduled.includes(state), false);
  assert.deepEqual(pruned, [path.join(home, 'bin'), home]);
});

test('purge removes only reverified environments and preserves referenced images and external roots', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-purge-'));
  const external = mkdtempSync(path.join(tmpdir(), 'devbridge-external-state-'));
  const config = path.join(home, 'config.json');
  const manifestFile = path.join(home, 'install-manifest.json');
  writeFileSync(config, '{}\n');
  const paths = { home, installManifest: manifestFile };
  const environmentIdentity = 'env-' + 'c'.repeat(32);
  const sourceIdentity = 'img-' + 'd'.repeat(32);
  await recordInstallEntries(paths, [
    { kind: 'path', role: 'config', path: config, ownership: 'created' },
    { kind: 'path', role: 'state', path: external, ownership: 'created-or-verified-managed' },
    { kind: 'environment', role: 'repository-environment', identity: environmentIdentity, subject: '1', stateDirectory: external, ownership: 'provider-verified-managed' },
    { kind: 'image', role: 'environment-source', identity: sourceIdentity, stateDirectory: external, ownership: 'referenced' },
  ]);
  let environments = [{
    record: { identity: environmentIdentity, subject: '1', source: { identity: sourceIdentity } },
    observation: { owned: true, compatible: true },
  }];
  const removed = [];
  let releases = 0;
  const foundation = {
    async listEnvironments() { return environments; },
    async removeEnvironment(identity) { removed.push(identity); environments = []; },
    async releaseNetwork() { releases += 1; },
    async releaseStorage() { releases += 1; },
  };
  let scheduled = null;
  const result = await uninstall(paths, ['uninstall', '--purge', '--confirm', 'REMOVE'], {
    input: { isTTY: false },
    output: outputPort(),
    foundationFactory: async () => foundation,
    scheduleFn: (targets) => { scheduled = targets; },
  });
  assert.deepEqual(removed, [environmentIdentity]);
  assert.equal(releases, 2);
  assert.equal(result.provider.preserved[0].identity, sourceIdentity);
  assert.equal(result.preservedPaths[0].path, external);
  assert.match(result.preservedPaths[0].reason, /retained provider artifacts/u);
  assert.equal(scheduled.includes(external), false);
  assert.equal(scheduled.includes(config), true);
  assert.equal(scheduled.includes(manifestFile), true);
});

test('uninstall requires an exact destructive confirmation and rejects unproven manifests', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-uninstall-confirm-'));
  const paths = { home, installManifest: path.join(home, 'install-manifest.json') };
  await assert.rejects(
    uninstall(paths, ['uninstall', '--app-only', '--confirm', 'remove'], { input: { isTTY: false }, output: outputPort() }),
    /exactly REMOVE/u,
  );
  await assert.rejects(
    uninstall(paths, ['uninstall', '--app-only', '--confirm', 'REMOVE'], { input: { isTTY: false }, output: outputPort() }),
    /manifest is missing/u,
  );
  await assert.rejects(
    recordInstallEntries(paths, [{ kind: 'path', role: 'runtime', path: path.dirname(home), ownership: 'created' }]),
    /escapes/u,
  );
  await recordInstallEntries(paths, [{ kind: 'path', role: 'runtime', path: home, ownership: 'created' }]);
  await assert.rejects(
    uninstall(paths, ['uninstall', '--app-only', '--confirm', 'REMOVE'], { input: { isTTY: false }, output: outputPort() }),
    /broad unsafe target/u,
  );
});