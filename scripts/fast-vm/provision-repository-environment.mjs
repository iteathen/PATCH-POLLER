#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEnvironmentBridge } from '../../src/app/environment-bridge.js';
import { createEnvironmentFoundation } from '../../src/app/environment-foundation.js';
import {
  executionProfileSubject,
  executionWorkspaceIdentity,
} from '../../src/app/execution-profile-routing.js';
import { createFastVmTopology } from '../../src/app/fast-vm-repository-execution.js';
import {
  ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
  normalizeEnvironmentExecutionRoutes,
  repositoryExecutionRoutesPath,
} from '../../src/app/repository-execution.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

async function writeOrMatch(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return 'created';
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== content) throw new Error(`existing local policy differs: ${file}`);
    return 'matched';
  }
}

async function readRoutePolicy(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new Error(`existing local route policy is not a bounded real file: ${file}`);
    }
    return normalizeEnvironmentExecutionRoutes(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function routeMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function upsertRoutePolicy(file, route) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let lock;
  try {
    lock = await open(lockFile, 'wx', 0o600);
    await lock.writeFile(`${randomUUID()}\n`, 'utf8');
  } catch (error) {
    await lock?.close().catch(() => {});
    if (error?.code === 'EEXIST') throw new Error(`local route policy is being changed by another process: ${file}`);
    throw error;
  }

  try {
    const current = await readRoutePolicy(file);
    const existing = current?.routes.find((entry) => entry.subject === route.subject && entry.profile === route.profile) ?? null;
    const intended = normalizeEnvironmentExecutionRoutes({
      protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
      routes: current?.routes ?? [],
    });
    const normalizedRoute = {
      ...route,
      validation: existing?.validation ?? !intended.routes.some((entry) => entry.validation),
    };
    if (existing) {
      if (!routeMatches(existing, normalizedRoute)) throw new Error(`existing local route differs for subject/profile: ${route.subject}/${route.profile}`);
      return 'matched';
    }

    const next = normalizeEnvironmentExecutionRoutes({
      protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
      routes: [...intended.routes, normalizedRoute],
    });
    const content = `${JSON.stringify(next)}\n`;
    if (current == null) {
      await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return 'created';
    }
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return 'extended';
  } finally {
    await lock.close().catch(() => {});
    await rm(lockFile, { force: true });
  }
}

export async function provisionExecutionProfileWorkspace({
  stateDirectory,
  identityFile,
  sourceKnownHostsFile,
  knownHostsFile,
  sourceIdentity,
  subject,
  profile = 'linux-development',
  memoryBytes = 4 * 1024 * 1024 * 1024,
  processorCount = 4,
} = {}) {
  const localStateDirectory = path.resolve(stateDirectory);
  const localIdentityFile = path.resolve(identityFile);
  const localSourceKnownHostsFile = path.resolve(sourceKnownHostsFile);
  const localKnownHostsFile = path.resolve(knownHostsFile);
  if (!/^\d+$/u.test(subject)) throw new Error('workspace subject must be a numeric immutable identity');
  if (!/^img-[a-f0-9]{32}$/u.test(sourceIdentity)) throw new Error('source identity is invalid');

  const profileSubject = executionProfileSubject(profile);
  const workspaceIdentity = executionWorkspaceIdentity(subject, profile);
  const foundation = await createEnvironmentFoundation({ stateDirectory: localStateDirectory });
  const storage = await foundation.ensureStorage();
  if (storage.ready !== true) throw new Error('owned environment storage did not become ready');
  const environment = await foundation.ensureEnvironment({
    subject: profileSubject,
    profile,
    sourceIdentity,
    settings: { memoryBytes, processorCount, firmware: 'efi' },
  });
  const baseAccess = async () => ({
    family: 'linux',
    user: 'devbridge',
    identityFile: localIdentityFile,
    knownHostsFile: localKnownHostsFile,
  });
  const topology = createFastVmTopology({ stateDirectory: localStateDirectory, access: baseAccess });
  const connection = await topology.connection(environment.record.identity);

  const sourceHostLine = (await readFile(localSourceKnownHostsFile, 'utf8')).trim();
  const hostParts = sourceHostLine.split(/\s+/u);
  if (hostParts.length < 3 || !hostParts[1].startsWith('ssh-')) throw new Error('source guest host-key record is invalid');
  hostParts[0] = '*';
  const knownHostsState = await writeOrMatch(localKnownHostsFile, `${hostParts.join(' ')}\n`);
  const route = {
    subject,
    profile,
    preferred: true,
    validation: false,
    access: {
      family: 'linux',
      user: 'devbridge',
      identityFile: localIdentityFile,
      knownHostsFile: localKnownHostsFile,
    },
  };
  const routesFile = repositoryExecutionRoutesPath(localStateDirectory);
  const routesState = await upsertRoutePolicy(routesFile, route);
  const readiness = await topology.ensure(environment.record.identity);
  const bridge = await createEnvironmentBridge({ stateDirectory: localStateDirectory, access: (target) => topology.connection(target) });
  const health = await bridge.health(environment.record.identity);
  if (health.ready !== true) throw new Error(health.reason ?? 'fast VM bridge did not become ready');
  const observed = await foundation.observeEnvironment(environment.record.identity);
  return {
    networking: { ready: true, mode: 'fast-default-switch' },
    storage,
    profile: {
      id: profile,
      subject: profileSubject,
      environment: observed,
    },
    workspace: {
      subject,
      identity: workspaceIdentity,
    },
    connection,
    knownHosts: { file: localKnownHostsFile, state: knownHostsState },
    routes: { file: routesFile, state: routesState },
    readiness,
    health,
  };
}

// Compatibility export for the Stage-8 caller while the setup vocabulary migrates.
// The operation now provisions a profile VM plus one workspace route; it never
// derives VM identity from the repository subject.
export const provisionRepositoryEnvironment = provisionExecutionProfileWorkspace;

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  provisionExecutionProfileWorkspace({
    stateDirectory: argument('--state-directory'),
    identityFile: argument('--identity-file'),
    sourceKnownHostsFile: argument('--source-known-hosts-file'),
    knownHostsFile: argument('--known-hosts-file'),
    sourceIdentity: argument('--source-identity'),
    subject: argument('--subject'),
  }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
