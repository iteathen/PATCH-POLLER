import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  hasSelectedEntrySelector,
  loadDefaultEntry,
  loadSelectedEntry,
  runInstalledEntry,
} from '../devbridge-entry.mjs';

test('installed entry routes ordinary invocation through stable runner management without an explicit ref selector', async () => {
  for (const argv of [
    ['doctor', '--config', 'local.json'],
    ['--channel', 'stable', 'status'],
    ['--channel', 'testing', 'daemon'],
    ['entry-status'],
  ]) {
    const calls = [];
    const status = await runInstalledEntry(argv, {
      defaultEntryLoader: async () => async (received) => { calls.push(['stable', received]); return 17; },
      selectedEntryLoader: async () => { throw new Error('selected path must not load'); },
    });
    assert.equal(status, 17);
    assert.deepEqual(calls, [['stable', argv]]);
  }
});

test('installed entry recognizes only explicit ref or branch selection and preserves argv for experimental composition', async () => {
  for (const selector of [
    ['--ref', 'fix/157-controller-owned-fixture'],
    ['--branch', 'a'.repeat(40)],
  ]) {
    const argv = [...selector, 'daemon', '--config', 'local.json'];
    const calls = [];
    const status = await runInstalledEntry(argv, {
      defaultEntryLoader: async () => { throw new Error('stable path must not load'); },
      selectedEntryLoader: async () => async (forwarded) => { calls.push(['selected', forwarded]); return 23; },
    });
    assert.equal(status, 23);
    assert.deepEqual(calls, [['selected', argv]]);
  }
});

test('installed entry rejects malformed or conflicting local selectors before either route loads', async () => {
  assert.equal(hasSelectedEntrySelector([]), false);
  assert.equal(hasSelectedEntrySelector(['--channel', 'stable']), false);
  assert.equal(hasSelectedEntrySelector(['--ref', 'topic']), true);
  assert.throws(() => hasSelectedEntrySelector(['--ref']), /requires a local selector value/u);
  assert.throws(() => hasSelectedEntrySelector(['--branch', '--channel', 'stable']), /requires a local selector value/u);
  let loads = 0;
  await assert.rejects(
    () => runInstalledEntry(['--ref', 'one', '--branch', 'two'], {
      defaultEntryLoader: async () => { loads += 1; return async () => 0; },
      selectedEntryLoader: async () => { loads += 1; return async () => 0; },
    }),
    /Only one installed-entry selector/u,
  );
  assert.equal(loads, 0);
});

test('explicit selected recovery does not load the stable/default manager', async () => {
  let defaultLoads = 0;
  const status = await runInstalledEntry(['--ref', 'fix/157-controller-owned-fixture', 'doctor'], {
    defaultEntryLoader: async () => {
      defaultLoads += 1;
      throw new SyntaxError('simulated incompatible stable manager');
    },
    selectedEntryLoader: async () => async () => 29,
  });
  assert.equal(status, 29);
  assert.equal(defaultLoads, 0);
});

test('permanent router has no static dependency on neighboring evolving modules', async () => {
  const source = await readFile(new URL('../devbridge-entry.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"];?$/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['node:path', 'node:process', 'node:url']);
  assert.doesNotMatch(source, /\bfrom\s*['"]\.\//u);
  assert.doesNotMatch(source, /\bimport\s*['"]\.\//u);
  assert.match(source, /new URL\('\.\/src\/entry\/stable-entry\.mjs', import\.meta\.url\)/u);
  assert.doesNotMatch(source, /new URL\('\.\/devbridge\.mjs', import\.meta\.url\)/u);
});

test('default and selected module loaders resolve separate local entry modules lazily', async () => {
  const observed = [];
  const defaultEntry = async () => 1;
  const selectedEntry = async () => 2;
  assert.equal(await loadDefaultEntry({
    importModuleFn: async (url) => { observed.push(['default', url]); return { runStableEntry: defaultEntry }; },
  }), defaultEntry);
  assert.equal(await loadSelectedEntry({
    importModuleFn: async (url) => { observed.push(['selected', url]); return { runExperimentalEntry: selectedEntry }; },
  }), selectedEntry);
  assert.match(observed[0][1], /\/src\/entry\/stable-entry\.mjs$/u);
  assert.match(observed[1][1], /\/src\/entry\/experimental-entry\.mjs$/u);
  assert.notEqual(observed[0][1], observed[1][1]);
});

test('one route cannot satisfy the other route contract accidentally', async () => {
  await assert.rejects(
    () => loadDefaultEntry({ importModuleFn: async () => ({ runExperimentalEntry: async () => 0 }) }),
    /default entry must be a function/u,
  );
  await assert.rejects(
    () => loadSelectedEntry({ importModuleFn: async () => ({ runStableEntry: async () => 0 }) }),
    /selected entry must be a function/u,
  );
});
