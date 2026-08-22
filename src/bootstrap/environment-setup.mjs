import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createEnvironmentFoundation } from '../app/environment-foundation.js';
import {
  executionProfileSubject,
  executionWorkspaceIdentity,
} from '../app/execution-profile-routing.js';
import { ensureWindowsFoundationNetwork } from './elevated-provider-setup.mjs';
import {
  ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
  normalizeEnvironmentExecutionRoutes,
  repositoryExecutionRoutesPath,
} from '../app/repository-execution.js';
import { provisionExecutionProfileWorkspace } from '../../scripts/fast-vm/provision-repository-environment.mjs';

const PROFILE = 'linux-development';

function optionValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

async function readRoutes(stateDirectory) {
  const file = repositoryExecutionRoutesPath(stateDirectory);
  if (!existsSync(file)) return { file, protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL, routes: [] };
  return { file, ...normalizeEnvironmentExecutionRoutes(JSON.parse(await readFile(file, 'utf8'))) };
}

function selectNames(value, options) {
  const raw = String(value || '').split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
  if (raw.length === 0 || (raw.length === 1 && raw[0].toLowerCase() === 'none')) return [];
  if (raw.length === 1 && raw[0].toLowerCase() === 'all') return options.filter((entry) => entry.ready || entry.provisionable).map((entry) => entry.repository);
  return raw.map((entry) => {
    if (/^\d+$/u.test(entry)) {
      const option = options[Number.parseInt(entry, 10) - 1];
      if (!option) throw new Error(`Workspace option ${entry} is out of range.`);
      return option.repository;
    }
    return entry;
  });
}

function yesNo(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  throw new Error('Execution selection must be yes or no.');
}

async function writeExecutionPolicy(configFile, { useFastVm, enabled }) {
  const raw = JSON.parse(await readFile(configFile, 'utf8'));
  raw.execution ??= {};
  raw.execution.fastHost = false;
  raw.execution.fastVmDefaultSwitch = useFastVm;
  raw.execution.enabled = enabled;
  const temp = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, configFile);
}

function readyEnvironment(entry) {
  return entry?.observation?.exists === true && entry.observation.owned === true && entry.observation.compatible === true;
}

export async function inspectEnvironmentSetup(config, repositoryRecords, {
  platform = process.platform,
  foundationFactory = createEnvironmentFoundation,
} = {}) {
  const foundation = await foundationFactory({ stateDirectory: config.state.directory, platform });
  const [status, images, environments, routes] = await Promise.all([
    foundation.inspect(),
    foundation.listImages(),
    foundation.listEnvironments(),
    readRoutes(config.state.directory),
  ]);
  const activeImages = images.filter((entry) => entry.profile === PROFILE && entry.retiredAt == null);
  const source = activeImages.at(-1) ?? null;
  const validationRoute = routes.routes.find((entry) => entry.validation === true && entry.profile === PROFILE) ?? null;
  const profileSubject = executionProfileSubject(PROFILE);
  const profileMatches = environments.filter((entry) => entry.record?.subject === profileSubject && entry.record?.profile === PROFILE);
  if (profileMatches.length > 1) throw new Error(`Execution profile ${PROFILE} has multiple persistent environments.`);
  const profileEnvironment = profileMatches[0] ?? null;
  const profileReady = readyEnvironment(profileEnvironment);
  const legacyEnvironments = environments.filter((entry) => entry.record?.profile === PROFILE && entry.record?.subject !== profileSubject);
  const discovered = new Map(repositoryRecords.map((entry) => [entry.name.toLowerCase(), entry]));
  const options = config.github.queueRepositories.map((repository) => {
    const record = discovered.get(repository.toLowerCase()) ?? null;
    const subject = record?.id ?? null;
    const route = subject ? routes.routes.find((entry) => entry.subject === subject && entry.profile === PROFILE) ?? null : null;
    const ready = profileReady && route != null;
    const blockers = [];
    if (!subject) blockers.push('immutable repository identity was not discovered');
    if (platform !== 'win32') blockers.push('the disposable automatic environment path is currently Hyper-V/Windows only');
    if (!source) blockers.push('no active linux-development base image is published in this state root');
    if (!validationRoute) blockers.push('no validation route supplies the fast guest access enrollment basis');
    return Object.freeze({
      repository,
      subject,
      workspace: subject ? executionWorkspaceIdentity(subject, PROFILE) : null,
      ready,
      provisionable: !ready && blockers.length === 0,
      environment: profileEnvironment?.record?.identity ?? null,
      state: profileEnvironment?.observation?.state ?? null,
      blocker: ready || blockers.length === 0 ? null : blockers.join('; '),
    });
  });
  return {
    foundation,
    status,
    source,
    validationRoute,
    routes,
    profile: Object.freeze({
      id: PROFILE,
      subject: profileSubject,
      ready: profileReady,
      provisionable: platform === 'win32' && source != null && validationRoute != null,
      environment: profileEnvironment?.record?.identity ?? null,
      state: profileEnvironment?.observation?.state ?? null,
      legacyEnvironmentCount: legacyEnvironments.length,
    }),
    legacyEnvironments,
    options,
  };
}

export async function setupEnvironments(config, repositoryRecords, argv, {
  input = process.stdin,
  output = process.stdout,
  platform = process.platform,
  foundationFactory = createEnvironmentFoundation,
  provisionFn = provisionExecutionProfileWorkspace,
  networkSetupFn = ensureWindowsFoundationNetwork,
  promptFactory = createInterface,
} = {}) {
  let inspection = await inspectEnvironmentSetup(config, repositoryRecords, { platform, foundationFactory });
  const explicit = optionValues(argv, '--environment');
  const all = argv.includes('--all-environments');
  const none = argv.includes('--no-environments');
  const enable = argv.includes('--enable-execution');
  const disable = argv.includes('--disable-execution');
  if ((all && none) || (enable && disable) || (explicit.length > 0 && (all || none))) throw new Error('Environment setup options are contradictory.');
  let selected = explicit;
  let executionEnabled = enable ? true : disable ? false : null;
  const supplied = explicit.length > 0 || all || none || enable || disable;

  if (!supplied && input.isTTY === true && output.isTTY === true) {
    output.write('\nExecution profiles:\n');
    const profileState = inspection.profile.ready
      ? `ready (${inspection.profile.environment}, ${inspection.profile.state})`
      : inspection.profile.provisionable
        ? 'can create one persistent VM'
        : 'not provisionable';
    output.write(`  ${inspection.profile.id}: ${profileState}\n`);
    if (inspection.profile.legacyEnvironmentCount > 0) {
      output.write(`  ${inspection.profile.legacyEnvironmentCount} repository-owned VM(s) are retained as migration candidates and are not selected as the execution profile.\n`);
    }
    output.write('\nRepository workspace options:\n');
    inspection.options.forEach((entry, index) => {
      const state = entry.ready
        ? `ready in ${inspection.profile.id} (${entry.workspace})`
        : entry.provisionable
          ? `can register workspace in ${inspection.profile.id}`
          : `poll-only: ${entry.blocker}`;
      output.write(`  ${index + 1}. ${entry.repository}: ${state}\n`);
    });
    const prompt = promptFactory({ input, output });
    try {
      while (true) {
        const answer = await prompt.question('Repository workspace selections (numbers, all, none, or configured owner/name; separate with spaces or commas) [none]: ');
        try {
          selected = selectNames(answer, inspection.options);
          const selectedSet = new Set(selected.map((value) => value.toLowerCase()));
          for (const repository of selectedSet) {
            const option = inspection.options.find((entry) => entry.repository.toLowerCase() === repository);
            if (!option) throw new Error(`Workspace selection is not a configured repository: ${repository}`);
            if (!option.ready && !option.provisionable) throw new Error(`Cannot use ${option.repository}: ${option.blocker}`);
          }
          break;
        } catch (error) {
          output.write(`  Invalid workspace selection: ${String(error?.message ?? error)} Try again.\n`);
        }
      }
      while (true) {
        const answer = await prompt.question(`Enable repository execution for selected workspaces (${selected.length > 0 ? 'yes' : 'no'}) [${selected.length > 0 ? 'yes' : 'no'}]: `);
        try {
          executionEnabled = yesNo(answer, selected.length > 0);
          if (executionEnabled && selected.length === 0) throw new Error('Repository execution requires at least one selected workspace.');
          break;
        } catch (error) {
          output.write(`  Invalid execution selection: ${String(error?.message ?? error)} Try again.\n`);
        }
      }
    } finally {
      prompt.close();
    }
  } else if (all) {
    selected = inspection.options.filter((entry) => entry.ready || entry.provisionable).map((entry) => entry.repository);
  } else if (none) {
    selected = [];
  }

  if (!supplied && input.isTTY !== true) {
    output.write(`${JSON.stringify({
      provider: inspection.status,
      profile: inspection.profile,
      source: inspection.source,
      workspaces: inspection.options,
      changed: false,
      completed: false,
      hint: 'Re-run setup with --all-environments, repeated --environment owner/name, or --no-environments; add --enable-execution or --disable-execution.',
    }, null, 2)}\n`);
    return { completed: false, changed: false };
  }

  const selectedSet = new Set(selected.map((value) => value.toLowerCase()));
  for (const repository of selectedSet) {
    if (!inspection.options.some((entry) => entry.repository.toLowerCase() === repository)) throw new Error(`Workspace selection is not a configured repository: ${repository}`);
  }
  if (platform === 'win32' && selectedSet.size > 0 && inspection.status.capabilities?.networking?.ready === false) {
    const confirmed = argv.includes('--allow-provider-elevation') && optionValues(argv, '--confirm').includes('APPLY');
    await networkSetupFn({
      stateDirectory: config.state.directory,
      foundation: inspection.foundation,
      input,
      output,
      allowElevation: confirmed,
      promptFactory,
    });
    inspection = await inspectEnvironmentSetup(config, repositoryRecords, { platform, foundationFactory });
  }
  for (const option of inspection.options.filter((entry) => selectedSet.has(entry.repository.toLowerCase()))) {
    if (option.ready) continue;
    if (!option.provisionable) throw new Error(`Cannot provision workspace for ${option.repository}: ${option.blocker}`);
    await provisionFn({
      stateDirectory: config.state.directory,
      identityFile: inspection.validationRoute.access.identityFile,
      sourceKnownHostsFile: inspection.validationRoute.access.knownHostsFile,
      knownHostsFile: inspection.validationRoute.access.knownHostsFile,
      sourceIdentity: inspection.source.identity,
      subject: option.subject,
      profile: PROFILE,
    });
  }
  inspection = await inspectEnvironmentSetup(config, repositoryRecords, { platform, foundationFactory });
  const unresolved = inspection.options.filter((entry) => selectedSet.has(entry.repository.toLowerCase()) && !entry.ready);
  if (unresolved.length > 0) throw new Error(`Selected workspaces did not become ready: ${unresolved.map((entry) => entry.repository).join(', ')}`);
  const useFastVm = selectedSet.size > 0;
  const enabled = executionEnabled ?? useFastVm;
  if (enabled && !useFastVm) throw new Error('Repository execution cannot be enabled without at least one ready selected workspace.');
  await writeExecutionPolicy(config.__file, { useFastVm, enabled });
  const managedProfiles = useFastVm && inspection.profile.ready ? [{
    profile: inspection.profile.id,
    subject: inspection.profile.subject,
    identity: inspection.profile.environment,
  }] : [];
  const managedWorkspaces = inspection.options
    .filter((entry) => selectedSet.has(entry.repository.toLowerCase()) && entry.ready)
    .map((entry) => ({ repository: entry.repository, subject: entry.subject, identity: entry.workspace, profile: inspection.profile.id }));
  output.write(`${JSON.stringify({
    provider: inspection.status,
    profile: inspection.profile,
    workspaces: inspection.options,
    selected: [...selectedSet],
    executionEnabled: enabled,
    changed: true,
    completed: true,
  }, null, 2)}\n`);
  return {
    completed: true,
    changed: true,
    selected: [...selectedSet],
    executionEnabled: enabled,
    stateDirectory: config.state.directory,
    managedProfiles,
    managedWorkspaces,
    // Compatibility with the existing install-manifest composition. This list
    // is deliberately profile-scoped and therefore contains at most one entry
    // for the current profile, regardless of repository count.
    managedEnvironments: managedProfiles,
    sourceIdentity: useFastVm ? inspection.source?.identity ?? null : null,
  };
}
