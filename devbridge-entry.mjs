#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SELECTED_ENTRY_FLAGS = new Set(['--ref', '--branch']);
const DEFAULT_ENTRY_URL = new URL('./src/entry/stable-entry.mjs', import.meta.url).href;
const SELECTED_ENTRY_URL = new URL('./src/entry/experimental-entry.mjs', import.meta.url).href;

function fail(message) { throw new Error(message); }

function requireEntry(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

async function loadEntry(url, exportName, importModuleFn, label) {
  requireEntry(importModuleFn, 'entry module loader');
  let module;
  try { module = await importModuleFn(url); }
  catch { fail(`${label} is unavailable`); }
  return requireEntry(module?.[exportName], label);
}

export function hasSelectedEntrySelector(argv) {
  if (!Array.isArray(argv)) throw new TypeError('installed-entry argv must be an array');
  let selected = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!SELECTED_ENTRY_FLAGS.has(flag)) continue;
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires a local selector value`);
    if (selected) fail('Only one installed-entry selector may be supplied.');
    selected = true;
    index += 1;
  }
  return selected;
}

export async function loadDefaultEntry({ importModuleFn = (url) => import(url) } = {}) {
  return loadEntry(DEFAULT_ENTRY_URL, 'runStableEntry', importModuleFn, 'default entry');
}

export async function loadSelectedEntry({ importModuleFn = (url) => import(url) } = {}) {
  return loadEntry(SELECTED_ENTRY_URL, 'runExperimentalEntry', importModuleFn, 'selected entry');
}

export async function runInstalledEntry(argv = process.argv.slice(2), {
  defaultEntryLoader = loadDefaultEntry,
  selectedEntryLoader = loadSelectedEntry,
} = {}) {
  requireEntry(defaultEntryLoader, 'defaultEntryLoader');
  requireEntry(selectedEntryLoader, 'selectedEntryLoader');
  const input = [...argv];
  const selected = hasSelectedEntrySelector(input);
  const entry = selected
    ? requireEntry(await selectedEntryLoader(), 'selected entry')
    : requireEntry(await defaultEntryLoader(), 'default entry');
  return entry([...input]);
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const status = await runInstalledEntry();
    if (Number.isInteger(status)) process.exitCode = status;
  } catch (error) {
    process.stderr.write(`[devbridge-entry] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
