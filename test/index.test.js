// Pure-function tests for the Vortex extension: no Vortex, no preflight binary, no game.
// The fake context follows Vortex 2.9's real call shapes: deploy events pass a profile id and are
// subscribed with onAsync; start hooks receive run parameters and cancel by throwing UserCanceled.

const test = require('node:test');
const assert = require('node:assert');
const ext = require('../src/index.js');

const scan = {
  schema: 'preflight/v1',
  engine: '0.1.0',
  command: 'scan',
  rules_bundle: { release: '2026-10-30.1', sha256: 'a'.repeat(64), path: 'rules.json' },
  game: { root: 'C:/Games/CP77', exe_version: '3.0.88.46235', patch: '2.5' },
  frameworks: [{ id: 'red4ext', version: '1.30.0', detected_by: 'sha256', paths: ['red4ext/RED4ext.dll'] }],
  plugins: [],
  actions: [
    { title: 'Update RED4ext to 1.31.0', effect: 'block', fix: { action: 'update', target: 'red4ext' }, findings: ['W-red4ext-window', 'R-0107'] },
    { title: 'modlist.txt lists archives that are not installed (preflight fix stale-modlist)', effect: 'warn', fix: { action: 'repair', fix_id: 'stale-modlist' }, findings: ['L-stale-modlist'] },
  ],
  findings: [
    {
      id: 'W-red4ext-window',
      source: 'window',
      effect: 'block',
      confidence: 'established',
      title: 'RED4ext 1.30.0 does not support patch 2.5',
      message: 'RED4ext 1.30.0 was built for patch 2.2 to 2.31; this game is patch 2.5.',
      chain: ['Game is patch 2.5 (exe 3.0.88.46235)', 'RED4ext 1.30.0 is installed (sha256)'],
      fix: { action: 'update', target: 'red4ext' },
    },
    {
      id: 'S-redscript-cache-corrupt',
      source: 'signature',
      effect: 'warn',
      confidence: 'reported',
      title: 'The script cache is corrupt',
      message: 'redscript says the installation might be corrupted.',
      chain: ['redscript_rCURRENT.log:3: ...', 'matched signature S-redscript-cache-corrupt [corrupt_script_cache]'],
      fix: { action: 'repair', fix_id: 'clear-script-cache' },
    },
    {
      id: 'L-stale-modlist',
      source: 'layout',
      effect: 'warn',
      confidence: 'established',
      title: 'modlist.txt lists archives that are not installed',
      message: 'archive/pc/mod/modlist.txt names 1 archive(s) that no longer exist.',
      chain: ['modlist.txt lists gone.archive', 'none of those files exist in archive/pc/mod'],
      fix: { action: 'repair', fix_id: 'stale-modlist' },
    },
  ],
  verdict: 'block',
};

class UserCanceled extends Error {}

function fakeContext({ activeGame = 'cyberpunk2077' } = {}) {
  const healthChecks = [];
  const actions = [];
  const asyncEvents = {};
  const startHooks = [];
  const pages = [];
  const dialogs = [];
  const state = {
    settings: {
      gameMode: { discovered: { cyberpunk2077: { path: '/nonexistent' } } },
      profiles: { activeProfileId: 'p1' },
    },
    persistent: { profiles: { p1: { gameId: activeGame }, p2: { gameId: 'skyrimse' } } },
  };
  const api = {
    getState: () => state,
    showDialog: async (type, title, content, buttons) => {
      dialogs.push({ type, title, content, buttons });
      return { action: 'Close' };
    },
    onAsync: (name, handler) => { asyncEvents[name] = handler; },
    events: { on: () => { throw new Error('deploy events must use onAsync'); } },
    util: { UserCanceled },
  };
  const context = {
    api,
    registerHealthCheck: (check) => healthChecks.push(check),
    registerAction: (group, position, icon, options, title, action) => actions.push({ group, position, icon, options, title, action }),
    registerStartHook: (priority, id, hook) => startHooks.push({ priority, id, hook }),
    registerMainPage: (icon, title, component, options) => pages.push({ icon, title, component, options }),
  };
  return { context, api, healthChecks, actions, asyncEvents, startHooks, pages, dialogs };
}

test('the extension registers its hooks with Vortex 2.9 call shapes', () => {
  const { context, healthChecks, actions, asyncEvents, startHooks } = fakeContext();
  assert.strictEqual(ext.default(context), true);
  assert.deepStrictEqual(healthChecks.map((c) => c.id), ['preflight-frameworks', 'preflight-environment', 'preflight-logs']);
  for (const check of healthChecks) {
    assert.strictEqual(check.gameId, 'cyberpunk2077');
    assert.ok(check.check && check.fix, check.id);
  }
  assert.deepStrictEqual(Object.keys(asyncEvents), ['did-deploy']);
  assert.strictEqual(startHooks.length, 1);
  assert.strictEqual(actions[0].title, 'Preflight report');
});

test('exit codes map to statuses', () => {
  assert.strictEqual(ext.exitToStatus(0), 'passed');
  assert.strictEqual(ext.exitToStatus(1), 'warning');
  assert.strictEqual(ext.exitToStatus(3), 'failed');
  assert.strictEqual(ext.exitToStatus(2), 'error');
});

test('findings are grouped by health check', () => {
  assert.strictEqual(ext.familyOf(scan.findings[0]), 'frameworks');
  assert.strictEqual(ext.familyOf(scan.findings[1]), 'logs');
  assert.strictEqual(ext.familyOf(scan.findings[2]), 'environment');
  assert.strictEqual(ext.familyOf({ id: 'P-build-changed', source: 'build' }), 'environment');
});

test('the fix button runs only the fixes the scan names', () => {
  assert.deepStrictEqual(ext.fixIdsFor(scan, 'environment'), ['stale-modlist']);
  assert.deepStrictEqual(ext.fixIdsFor(scan, 'logs'), ['clear-script-cache']);
  assert.deepStrictEqual(ext.fixIdsFor(scan, 'frameworks'), [], 'an update needs the user, not a catalogue fix');
  const frameworks = ext.toHealthResult({ scan, code: 3, checkId: 'preflight-frameworks', elapsedMs: 1 });
  assert.strictEqual(frameworks.fixAvailable, false);
  const env = ext.toHealthResult({ scan, code: 3, checkId: 'preflight-environment', elapsedMs: 1 });
  assert.strictEqual(env.fixAvailable, true);
});

test('a blocking finding fails its check even when the exit code is odd', () => {
  const result = ext.toHealthResult({ scan, code: 1, checkId: 'preflight-frameworks', elapsedMs: 12 });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.severity, 'error');
  assert.strictEqual(result.metadata.findings[0].id, 'W-red4ext-window');
  assert.ok(result.details.includes('RED4ext 1.30.0 is installed'), result.details);
});

test('a clean scan passes every check', () => {
  const clean = { ...scan, actions: [], findings: [], verdict: 'info' };
  for (const checkId of ['preflight-frameworks', 'preflight-environment', 'preflight-logs']) {
    const result = ext.toHealthResult({ scan: clean, code: 0, checkId, elapsedMs: 3 });
    assert.strictEqual(result.status, 'passed', checkId);
    assert.strictEqual(result.fixAvailable, false);
  }
});

test('the report leads with what to do', () => {
  const text = ext.summarise(scan);
  assert.ok(text.startsWith('BLOCK: 1 thing(s) to do before launch on patch 2.5'), text);
  assert.ok(text.includes('1. [BLOCK] Update RED4ext to 1.31.0  (fixes 2 problems)'), text);
  assert.ok(text.includes('- Game is patch 2.5 (exe 3.0.88.46235)'), text);
  assert.ok(text.includes('rules: 2026-10-30.1'), text);
});

test('bad JSON produces a message a user can act on', () => {
  assert.throws(() => ext.parseScan('<html>'), /preflight did not return JSON/);
});

test('deploy events carry a profile id, which maps to a game', () => {
  const { api } = fakeContext();
  assert.strictEqual(ext.gameOfProfile(api.getState(), 'p1'), 'cyberpunk2077');
  assert.strictEqual(ext.gameOfProfile(api.getState(), 'p2'), 'skyrimse');
  assert.strictEqual(ext.gameOfProfile(api.getState(), 'cyberpunk2077'), undefined);
  assert.strictEqual(ext.activeGame(api.getState()), 'cyberpunk2077');
});

test('the launch check passes the launch through for other games and when preflight cannot run', async () => {
  const other = fakeContext({ activeGame: 'skyrimse' });
  const input = { executable: 'game.exe', args: [] };
  assert.strictEqual(await ext.preLaunch(other.api, input), input);
  const mine = fakeContext();
  assert.strictEqual(await ext.preLaunch(mine.api, input), input, 'binary missing: never block');
  assert.deepStrictEqual(mine.dialogs, []);
});

test('after a deploy of another game nothing runs', async () => {
  const { api, dialogs } = fakeContext();
  await ext.afterDeploy(api, 'p2');
  await ext.afterDeploy(api, 'p1'); // binary missing: swallowed, never breaks the deploy
  assert.deepStrictEqual(dialogs, []);
});

test('undo picks the newest transaction that is not undone', () => {
  const journals = [
    { txid: 'b', fix_id: 'stale-modlist', undone: '2026-10-30T10:00:00Z' },
    { txid: 'a', fix_id: 'clear-script-cache' },
  ];
  assert.strictEqual(ext.lastUndoable(journals).txid, 'a');
  assert.strictEqual(ext.lastUndoable([]), null);
});

test('the main page model carries actions, chains and the patch-day board', () => {
  const vm = ext.viewModel({
    ...scan,
    patch_day: {
      from: '2.31',
      to: '2.5',
      build_date: '2026-10-22',
      frameworks: [{ id: 'red4ext', installed: '1.30.0', newest_for_build: '1.31.0', status: 'known_broken' }],
      plugins: [{ name: 'OldMod', status: 'unverified' }],
    },
  });
  assert.strictEqual(vm.actions[1].fixId, 'stale-modlist');
  assert.strictEqual(vm.actions[0].count, 2);
  assert.strictEqual(vm.findings[0].chain.length, 2);
  assert.strictEqual(vm.board.rows.length, 2);
  assert.ok(vm.board.title.includes('updated from 2.31'));
  assert.strictEqual(ext.viewModel(null).verdict, 'Scanning…');
});

test('the fix order is unique and starts with the cache', () => {
  assert.strictEqual(new Set(ext.FIX_ORDER).size, ext.FIX_ORDER.length);
  assert.strictEqual(ext.FIX_ORDER[0], 'clear-script-cache');
});
