import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionProfileRouting,
  createWorkspaceScopedChannel,
  executionProfileSubject,
  executionWorkspaceIdentity,
  executionWorkspaceTarget,
} from '../src/app/execution-profile-routing.js';

const PROFILE = 'linux-development';
const PHYSICAL = `env-${'a'.repeat(32)}`;
const ACCESS = Object.freeze({
  family: 'linux',
  user: 'devbridge',
  identityFile: '/host/id',
  knownHostsFile: '/host/known-hosts',
});

function policy(routes) {
  return {
    protocol: 'devbridge/environment-execution-routes-v1',
    routes: routes.map((entry) => ({
      subject: entry.subject,
      profile: PROFILE,
      preferred: true,
      validation: entry.validation === true,
      access: entry.access ?? ACCESS,
    })),
  };
}

function physicalState() {
  const entry = {
    record: {
      identity: PHYSICAL,
      subject: executionProfileSubject(PROFILE),
      profile: PROFILE,
      generation: 1,
      source: { identity: `img-${'b'.repeat(32)}`, revision: 'v1', digest: 'c'.repeat(64) },
      settings: { memoryBytes: 4096, processorCount: 4, firmware: 'efi' },
    },
    observation: {
      identity: PHYSICAL,
      exists: true,
      owned: true,
      compatible: true,
      state: 'running',
      reason: null,
      storage: null,
    },
  };
  return {
    async inspect() { return { ready: true, state: 'ready' }; },
    async listEnvironments() { return [structuredClone(entry)]; },
    async observeEnvironment(target) {
      assert.equal(target, PHYSICAL);
      return structuredClone(entry);
    },
  };
}

test('execution profile identity is independent of repository identity', () => {
  const profile = executionProfileSubject(PROFILE);
  assert.equal(profile, executionProfileSubject(PROFILE));
  assert.equal(profile.includes('101'), false);
  assert.equal(profile.includes('202'), false);
  assert.notEqual(executionWorkspaceIdentity('101', PROFILE), executionWorkspaceIdentity('202', PROFILE));
  assert.notEqual(executionWorkspaceTarget('101', PROFILE), executionWorkspaceTarget('202', PROFILE));
});

test('multiple repository workspaces resolve to one physical profile environment', async () => {
  const routing = createExecutionProfileRouting({
    state: physicalState(),
    policy: policy([{ subject: '101', validation: true }, { subject: '202' }]),
  });
  const environments = await routing.listEnvironments();
  assert.equal(environments.length, 2);
  assert.deepEqual(environments.map((entry) => entry.record.subject), ['101', '202']);
  assert.notEqual(environments[0].record.identity, environments[1].record.identity);
  assert.equal(await routing.physicalTarget(environments[0].record.identity), PHYSICAL);
  assert.equal(await routing.physicalTarget(environments[1].record.identity), PHYSICAL);
  assert.notEqual(routing.workspaceIdentity(environments[0].record.identity), routing.workspaceIdentity(environments[1].record.identity));
  assert.equal(await routing.representativeTarget(PHYSICAL), environments[0].record.identity);
});

test('one execution profile rejects conflicting guest-access topology', () => {
  assert.throws(() => createExecutionProfileRouting({
    state: physicalState(),
    policy: policy([
      { subject: '101', validation: true },
      { subject: '202', access: { ...ACCESS, user: 'other' } },
    ]),
  }), /conflicting guest-access configuration/u);
});

test('workspace channel scopes every repository-controlled bridge location', async () => {
  const target = executionWorkspaceTarget('101', PROFILE);
  const workspace = executionWorkspaceIdentity('101', PROFILE);
  const calls = [];
  const channel = {
    async health(selected) { calls.push(['health', selected]); return { ready: true }; },
    async execute(selected, operation) { calls.push(['execute', selected, operation]); return { completion: 'observed' }; },
    async put(selected, _source, destination) { calls.push(['put', selected, destination]); return { bytes: 1 }; },
    async get(selected, source) { calls.push(['get', selected, source]); return { bytes: 1 }; },
  };
  const routing = {
    async physicalTarget(selected) { assert.equal(selected, target); return PHYSICAL; },
    workspaceIdentity(selected) { assert.equal(selected, target); return workspace; },
  };
  const scoped = createWorkspaceScopedChannel({ channel, routing });
  await scoped.health(target);
  await scoped.put(target, {}, { class: 'input', path: 'source/manifest.json' });
  await scoped.get(target, { class: 'output', path: 'candidate/tree.json' }, {});
  await scoped.execute(target, {
    program: 'node',
    arguments: [
      'tool.mjs',
      { class: 'input', path: 'ports/request' },
      { class: 'output', path: 'ports/result' },
    ],
    directory: { class: 'work', path: '.' },
    environment: {},
  });

  assert.deepEqual(calls[0], ['health', PHYSICAL]);
  assert.deepEqual(calls[1], ['put', PHYSICAL, { class: 'input', path: `workspaces/${workspace}/source/manifest.json` }]);
  assert.deepEqual(calls[2], ['get', PHYSICAL, { class: 'output', path: `workspaces/${workspace}/candidate/tree.json` }]);
  assert.equal(calls[3][0], 'execute');
  assert.equal(calls[3][1], PHYSICAL);
  assert.deepEqual(calls[3][2].directory, { class: 'work', path: `workspaces/${workspace}` });
  assert.deepEqual(calls[3][2].arguments.slice(1), [
    { class: 'input', path: `workspaces/${workspace}/ports/request` },
    { class: 'output', path: `workspaces/${workspace}/ports/result` },
  ]);
});

test('workspace reset targets every class for exactly one workspace and leaves sibling identity untouched', async () => {
  const target = executionWorkspaceTarget('101', PROFILE);
  const workspace = executionWorkspaceIdentity('101', PROFILE);
  const sibling = executionWorkspaceIdentity('202', PROFILE);
  const removals = [];
  const channel = {
    async health() { return { ready: true }; },
    async execute(selected, operation) {
      assert.equal(selected, PHYSICAL);
      const location = operation.arguments.at(-1);
      removals.push(location);
      return {
        completion: 'observed',
        result: {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: '{"verifiedAbsent":true}',
          stderr: '',
        },
      };
    },
    async put() { return { bytes: 1 }; },
    async get() { return { bytes: 1 }; },
  };
  const routing = {
    async physicalTarget(selected) { assert.equal(selected, target); return PHYSICAL; },
    workspaceIdentity(selected) { assert.equal(selected, target); return workspace; },
  };
  const scoped = createWorkspaceScopedChannel({ channel, routing });
  const result = await scoped.resetWorkspace(target);
  assert.equal(result.verifiedAbsent, true);
  assert.equal(result.workspace, workspace);
  assert.deepEqual(result.classes, ['input', 'work', 'output', 'scratch', 'cache']);
  assert.deepEqual(removals.map((entry) => entry.class), ['input', 'work', 'output', 'scratch', 'cache']);
  for (const entry of removals) {
    assert.equal(entry.path, `workspaces/${workspace}`);
    assert.equal(entry.path.includes(sibling), false);
  }
});

test('workspace cleanup removes only transient workspace classes', async () => {
  const target = executionWorkspaceTarget('101', PROFILE);
  const workspace = executionWorkspaceIdentity('101', PROFILE);
  const classes = [];
  const channel = {
    async health() { return { ready: true }; },
    async execute(_selected, operation) {
      classes.push(operation.arguments.at(-1).class);
      return {
        completion: 'observed',
        result: { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"verifiedAbsent":true}', stderr: '' },
      };
    },
    async put() { return { bytes: 1 }; },
    async get() { return { bytes: 1 }; },
  };
  const scoped = createWorkspaceScopedChannel({
    channel,
    routing: {
      async physicalTarget() { return PHYSICAL; },
      workspaceIdentity() { return workspace; },
    },
  });
  const result = await scoped.cleanupWorkspace(target);
  assert.equal(result.verifiedAbsent, true);
  assert.deepEqual(classes, ['input', 'output', 'scratch']);
});

test('profile routing refuses legacy repository-owned VM state as the physical target', async () => {
  const legacy = physicalState();
  legacy.listEnvironments = async () => [{
    record: { identity: PHYSICAL, subject: '101', profile: PROFILE },
    observation: { identity: PHYSICAL, exists: true, owned: true, compatible: true, state: 'running' },
  }];
  const routing = createExecutionProfileRouting({ state: legacy, policy: policy([{ subject: '101', validation: true }]) });
  assert.deepEqual(await routing.listEnvironments(), []);
  await assert.rejects(routing.physicalTarget(executionWorkspaceTarget('101', PROFILE)), /no persistent environment/u);
});
