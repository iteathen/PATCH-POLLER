import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupEnvironments } from '../src/bootstrap/environment-setup.mjs';
import { executionProfileSubject } from '../src/app/execution-profile-routing.js';

const PROFILE = 'linux-development';
const PROFILE_ENVIRONMENT = `env-${'d'.repeat(32)}`;
const SOURCE = `img-${'a'.repeat(32)}`;

function outputPort() {
  let text = '';
  return { isTTY: false, write(value) { text += String(value); }, get text() { return text; } };
}

test('selecting all repositories creates one profile environment and multiple workspaces', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-profile-setup-'));
  const state = path.join(root, 'state');
  const foundationRoot = path.join(state, 'environment-foundation');
  mkdirSync(foundationRoot, { recursive: true });
  const routesFile = path.join(foundationRoot, 'execution-routes.json');
  const access = {
    family: 'linux',
    user: 'devbridge',
    identityFile: path.join(root, 'identity'),
    knownHostsFile: path.join(root, 'known-hosts'),
  };
  const routes = {
    protocol: 'devbridge/environment-execution-routes-v1',
    routes: [{ subject: '99', profile: PROFILE, preferred: true, validation: true, access }],
  };
  writeFileSync(routesFile, `${JSON.stringify(routes)}\n`);
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ execution: { enabled: false } }, null, 2)}\n`);
  const config = {
    __file: configFile,
    state: { directory: state },
    github: { queueRepositories: ['owner/one', 'owner/two'] },
  };

  let physicalEnvironment = null;
  let physicalCreates = 0;
  const foundation = {
    async inspect() {
      return {
        ready: true,
        state: 'ready',
        capabilities: { networking: { ready: true } },
      };
    },
    async listImages() { return [{ identity: SOURCE, profile: PROFILE, retiredAt: null }]; },
    async listEnvironments() { return physicalEnvironment ? [structuredClone(physicalEnvironment)] : []; },
  };
  const provisionedSubjects = [];
  const provisionFn = async (request) => {
    provisionedSubjects.push(request.subject);
    if (!physicalEnvironment) {
      physicalCreates += 1;
      physicalEnvironment = {
        record: {
          identity: PROFILE_ENVIRONMENT,
          subject: executionProfileSubject(PROFILE),
          profile: PROFILE,
        },
        observation: {
          identity: PROFILE_ENVIRONMENT,
          exists: true,
          owned: true,
          compatible: true,
          state: 'running',
        },
      };
    }
    const current = JSON.parse(readFileSync(routesFile, 'utf8'));
    if (!current.routes.some((entry) => entry.subject === request.subject && entry.profile === PROFILE)) {
      current.routes.push({ subject: request.subject, profile: PROFILE, preferred: true, validation: false, access });
      writeFileSync(routesFile, `${JSON.stringify(current)}\n`);
    }
    return {};
  };

  const result = await setupEnvironments(
    config,
    [{ name: 'owner/one', id: '1' }, { name: 'owner/two', id: '2' }],
    ['setup', '--all-environments', '--enable-execution'],
    {
      input: { isTTY: false },
      output: outputPort(),
      platform: 'win32',
      foundationFactory: async () => foundation,
      provisionFn,
    },
  );

  assert.equal(result.completed, true);
  assert.equal(physicalCreates, 1);
  assert.deepEqual(provisionedSubjects, ['1', '2']);
  assert.equal(result.managedProfiles.length, 1);
  assert.equal(result.managedProfiles[0].identity, PROFILE_ENVIRONMENT);
  assert.equal(result.managedEnvironments.length, 1);
  assert.equal(result.managedWorkspaces.length, 2);
  assert.notEqual(result.managedWorkspaces[0].identity, result.managedWorkspaces[1].identity);
  const updated = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(updated.execution.fastVmDefaultSwitch, true);
  assert.equal(updated.execution.enabled, true);
});
