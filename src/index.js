// Preflight for Vortex: runs the `preflight` binary and shows its findings through Vortex hooks.
// GPL-3.0-only. No analysis lives here: every decision comes from the binary's JSON output.
//
// Hooks: three health checks (frameworks, environment, logs) whose fix runs only the fixes the scan
// names; a start hook that checks before the game launches and can cancel the launch; a did-deploy
// lockfile write with a notice when the deployed loadout is blocked; a Preflight main page; a report
// dialog with undo.
//
// Why the gate sits on launch and not on deploy: Vortex 2.9 runs will-deploy handlers through
// emitAndAwait, which catches a handler's error and deploys anyway (ExtensionManager.ts emitAndAwait),
// so a will-deploy handler cannot stop a deploy. Start hooks can stop a launch (applyStartHooks
// rejects on UserCanceled).

'use strict';

const path = require('path');
const { execFile } = require('child_process');

const GAME_ID = 'cyberpunk2077';
const BINARY = 'preflight.exe';
const TIMEOUT_MS = 30000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Fixes run in this order when a scan names several: cheap cache/state first, then leftovers. */
const FIX_ORDER = [
  'clear-script-cache',
  'recreate-modded-cache',
  'readonly-final',
  'stale-addresses',
  'cet-nesting',
  'input-loader-ini',
  'stale-modlist',
  'unblock-dll',
  'remove-leftovers',
];

/** Exit code -> health-check status. */
function exitToStatus(code) {
  if (code === 0) return 'passed';
  if (code === 1) return 'warning';
  if (code === 3) return 'failed';
  return 'error';
}

function severityFor(status) {
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'warning') return 'warning';
  return 'info';
}

/** JSON parse with a message a user can act on. */
function parseScan(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`preflight did not return JSON: ${err.message}`);
  }
}

/** Which health check a finding belongs to. */
function familyOf(finding) {
  if (finding.source === 'signature') return 'logs';
  const id = String(finding.id);
  if (finding.source === 'layout' || finding.source === 'build' || id.startsWith('E-') || id.startsWith('P-')) {
    return 'environment';
  }
  return 'frameworks';
}

function findingsFor(scan, family) {
  return (scan.findings || []).filter((f) => family === 'all' || familyOf(f) === family);
}

function blockFindings(scan) {
  return (scan.findings || []).filter((f) => f.effect === 'block');
}

/** The catalogue fixes a scan asks for in one family, in FIX_ORDER order, each once. */
function fixIdsFor(scan, family) {
  const ids = new Set();
  for (const f of findingsFor(scan, family)) {
    if (f.fix && f.fix.fix_id) ids.add(f.fix.fix_id);
  }
  const known = FIX_ORDER.filter((id) => ids.has(id));
  const rest = [...ids].filter((id) => !FIX_ORDER.includes(id)).sort();
  return [...known, ...rest];
}

/** One-line verdict, e.g. "BLOCK: 2 thing(s) to do before launch on patch 2.5". */
function verdictLine(scan) {
  const todo = (scan.actions || []).filter((a) => a.effect === 'block').length || blockFindings(scan).length;
  const warns = (scan.findings || []).filter((f) => f.effect === 'warn').length;
  const patch = (scan.game && scan.game.patch) || 'unknown';
  if (scan.verdict === 'block') return `BLOCK: ${todo} thing(s) to do before launch on patch ${patch}`;
  if (scan.verdict === 'warn') return `WARN: ${warns} thing(s) need attention on patch ${patch}`;
  return `OK: patch ${patch} has nothing to fix before launch`;
}

/** Plain-text report: verdict, what to do, findings with their chains, then the frameworks seen. */
function summarise(scan) {
  const lines = [verdictLine(scan), ''];
  const actions = scan.actions || [];
  if (actions.length > 0) {
    lines.push('WHAT TO DO');
    actions.forEach((a, i) => {
      const n = (a.findings || []).length;
      lines.push(`  ${i + 1}. [${String(a.effect).toUpperCase()}] ${a.title}${n > 1 ? `  (fixes ${n} problems)` : ''}`);
    });
    lines.push('');
  }
  for (const effect of ['block', 'warn', 'info']) {
    const group = (scan.findings || []).filter((f) => f.effect === effect);
    if (group.length === 0) continue;
    lines.push(effect.toUpperCase());
    for (const finding of group) {
      lines.push(`  ${finding.id}  ${finding.title}`);
      lines.push(`      ${finding.message}`);
      for (const step of finding.chain || []) lines.push(`      - ${step}`);
    }
    lines.push('');
  }
  if ((scan.findings || []).length === 0) lines.push('Nothing to fix.', '');
  const frameworks = (scan.frameworks || []).map((f) => `${f.id} ${f.version}`).join(', ');
  if (frameworks) lines.push(`frameworks: ${frameworks}`);
  if (scan.rules_bundle) {
    lines.push(`rules: ${scan.rules_bundle.release} (${String(scan.rules_bundle.sha256).slice(0, 12)})`);
  }
  return lines.join('\n');
}

/** IHealthCheckResult for one health check, from the scan and the process exit code. */
function toHealthResult({ scan, code, checkId, elapsedMs }) {
  const family = checkId.replace(/^preflight-/, '');
  const findings = findingsFor(scan, family);
  const failed = findings.some((f) => f.effect === 'block');
  const fromExit = exitToStatus(code);
  const status = fromExit === 'error' ? 'error' : failed ? 'failed' : findings.length > 0 ? 'warning' : 'passed';
  const message =
    status === 'passed'
      ? `Preflight: ${verdictLine(scan)}`
      : `Preflight: ${findings.length} finding(s) for ${family}; ${verdictLine(scan)}`;
  return {
    checkId,
    status,
    severity: severityFor(status),
    message,
    details: summarise(scan),
    metadata: {
      verdict: scan.verdict,
      patch: scan.game && scan.game.patch,
      findings: findings.slice(0, 20).map((f) => ({ id: f.id, effect: f.effect, title: f.title })),
      rules_release: scan.rules_bundle && scan.rules_bundle.release,
    },
    executionTime: elapsedMs,
    timestamp: new Date(),
    // Only offer the fix button when the binary named a fix it can run.
    fixAvailable: fixIdsFor(scan, family).length > 0,
  };
}

/** What the main page shows; pure so it can be tested without React. */
function viewModel(scan) {
  if (!scan) return { verdict: 'Scanning…', effect: 'info', actions: [], findings: [], board: null };
  return {
    verdict: verdictLine(scan),
    effect: scan.verdict,
    actions: (scan.actions || []).map((a) => ({
      title: a.title,
      effect: a.effect,
      fixId: (a.fix && a.fix.fix_id) || null,
      count: (a.findings || []).length,
    })),
    findings: (scan.findings || []).map((f) => ({ id: f.id, effect: f.effect, title: f.title, chain: f.chain || [] })),
    board: scan.patch_day
      ? {
          title: `Patch ${scan.patch_day.to} (released ${scan.patch_day.build_date})${scan.patch_day.from ? `, updated from ${scan.patch_day.from}` : ''}`,
          rows: [
            ...(scan.patch_day.frameworks || []).map((f) => ({ name: f.id, version: f.installed, status: f.status, newest: f.newest_for_build || null })),
            ...(scan.patch_day.plugins || []).map((p) => ({ name: p.name, version: '', status: p.status, newest: null })),
          ],
        }
      : null,
  };
}

/** Game id of a Vortex profile; deploy events pass a profile id, not a game id. */
function gameOfProfile(state, profileId) {
  const profile = state && state.persistent && state.persistent.profiles && state.persistent.profiles[profileId];
  return profile ? profile.gameId : undefined;
}

function activeGame(state) {
  const profileId = state && state.settings && state.settings.profiles && state.settings.profiles.activeProfileId;
  return gameOfProfile(state, profileId);
}

/** The newest fix transaction that has not been undone yet. */
function lastUndoable(journals) {
  return (journals || []).find((j) => !j.undone) || null;
}

/** Vortex's error classes, from the runtime module or the api (tests inject them on the api). */
function vortexUtil(api) {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('vortex-api').util;
  } catch (err) {
    return (api && api.util) || {};
  }
}

function binaryPath() {
  return path.join(__dirname, BINARY);
}

/** Runs the binary; resolves for every exit code so the caller maps it. */
function runPreflight(args, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath(), args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new Error(`preflight timed out after ${timeout} ms`));
        return;
      }
      // A non-zero exit is a result, not a spawn failure; only spawn errors have error.code as a string.
      if (error && typeof error.code === 'string') {
        reject(new Error(`could not run ${binaryPath()}: ${error.message}`));
        return;
      }
      resolve({ code: error ? Number(error.code) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function gamePath(api) {
  const state = api.getState();
  const discovered = (state.settings && state.settings.gameMode && state.settings.gameMode.discovered) || {};
  return discovered[GAME_ID] && discovered[GAME_ID].path;
}

async function scanGame(root, command = 'scan') {
  const started = Date.now();
  const { code, stdout, stderr } = await runPreflight([command, '--game', root, '--json']);
  if (code === 2) throw new Error(stderr.trim() || `preflight ${command} failed`);
  return { scan: parseScan(stdout), code, elapsed: Date.now() - started };
}

async function applyFix(root, id) {
  const { code, stderr, stdout } = await runPreflight(['fix', '--game', root, id, '--apply', '--json']);
  if (code === 2) throw new Error(stderr.trim() || `fix ${id} failed`);
  return parseScan(stdout);
}

/** Runs exactly the fixes a fresh scan names for this family. */
async function applyFixesFor(root, family) {
  const run = await scanGame(root, family === 'logs' ? 'diagnose' : 'scan');
  const applied = [];
  for (const id of fixIdsFor(run.scan, family)) {
    await applyFix(root, id);
    applied.push(id);
  }
  return applied;
}

async function undoLast(root) {
  const { code, stdout, stderr } = await runPreflight(['journal', '--game', root, '--json']);
  if (code === 2) throw new Error(stderr.trim() || 'could not read the fix journal');
  const last = lastUndoable(parseScan(stdout));
  if (!last) return null;
  const undo = await runPreflight(['undo', '--game', root, last.txid, '--json']);
  if (undo.code === 2) throw new Error(undo.stderr.trim() || `undo ${last.txid} failed`);
  return last;
}

function makeCheck(api, { id, name, description, command }) {
  const family = id.replace(/^preflight-/, '');
  return {
    id,
    name,
    description,
    category: 'mods',
    severity: 'warning',
    triggers: ['startup', 'manual', 'profile-changed', 'mods-changed', 'game-changed'],
    gameId: GAME_ID,
    timeout: TIMEOUT_MS,
    check: async () => {
      const root = gamePath(api);
      if (!root) {
        return toHealthResult({ scan: { verdict: 'info', findings: [], game: { patch: 'unknown' } }, code: 0, checkId: id, elapsedMs: 0 });
      }
      try {
        const run = await scanGame(root, command);
        return toHealthResult({ scan: run.scan, code: run.code, checkId: id, elapsedMs: run.elapsed });
      } catch (err) {
        return { checkId: id, status: 'error', severity: 'error', message: err.message, executionTime: 0, timestamp: new Date() };
      }
    },
    fix: async () => {
      const root = gamePath(api);
      if (root) await applyFixesFor(root, family);
    },
  };
}

/** Before the game starts: on a blocking verdict, ask; cancel the launch only when the user says so. */
async function preLaunch(api, input) {
  if (activeGame(api.getState()) !== GAME_ID) return input;
  const root = gamePath(api);
  if (!root) return input;
  let scan;
  try {
    scan = (await scanGame(root)).scan;
  } catch (err) {
    return input; // never stop a launch because Preflight itself failed
  }
  if (scan.verdict !== 'block') return input;
  const result = await api.showDialog('warning', 'Preflight: this loadout will not run correctly', { text: summarise(scan) }, [
    { label: 'Cancel launch' },
    { label: 'Launch anyway' },
  ]);
  if (result && result.action === 'Cancel launch') {
    const Canceled = vortexUtil(api).UserCanceled || Error;
    throw new Canceled('Launch cancelled: Preflight found blocking problems');
  }
  return input;
}

async function afterDeploy(api, profileId) {
  if (gameOfProfile(api.getState(), profileId) !== GAME_ID) return;
  const root = gamePath(api);
  if (!root) return;
  try {
    const { scan } = await scanGame(root);
    if (scan.verdict === 'block' && api.sendNotification) {
      api.sendNotification({ type: 'warning', title: 'Preflight', message: verdictLine(scan), displayMS: 8000 });
    }
    if (scan.verdict !== 'block') await runPreflight(['lock', 'write', '--game', root]);
  } catch (err) {
    // A failing check never breaks a deploy.
  }
}

async function showReport(api) {
  const root = gamePath(api);
  if (!root) {
    await api.showDialog('info', 'Preflight', { text: 'Cyberpunk 2077 is not managed by Vortex yet.' }, [{ label: 'Close' }]);
    return;
  }
  const run = await scanGame(root);
  const result = await api.showDialog('info', 'Preflight report', { text: summarise(run.scan) }, [
    { label: 'Close' },
    { label: 'Undo last fix' },
  ]);
  if (result && result.action === 'Undo last fix') {
    const undone = await undoLast(root);
    const text = undone ? `Undid ${undone.fix_id} (${undone.txid}).` : 'There is no fix to undo.';
    await api.showDialog('info', 'Preflight', { text }, [{ label: 'Close' }]);
  }
}

/** The main page, built with React.createElement so the extension needs no build step. */
function makePage(api) {
  // eslint-disable-next-line global-require, import/no-unresolved
  const React = require('react');
  const h = React.createElement;
  const colour = { block: '#d9534f', warn: '#f0ad4e', info: '#5bc0de' };

  class PreflightPage extends React.Component {
    constructor(props) {
      super(props);
      this.state = { scan: null, busy: false, error: null, note: null };
    }

    componentDidMount() {
      this.refresh();
    }

    run(work, note) {
      const root = gamePath(api);
      if (!root) {
        this.setState({ error: 'Cyberpunk 2077 is not managed by Vortex yet.' });
        return;
      }
      this.setState({ busy: true, error: null, note: null });
      work(root)
        .then((result) => (note ? this.setState({ note: note(result) }) : null))
        .then(() => scanGame(root))
        .then((r) => this.setState({ scan: r.scan, busy: false }))
        .catch((err) => this.setState({ error: err.message, busy: false }));
    }

    refresh() {
      this.run(async () => null);
    }

    render() {
      const vm = viewModel(this.state.scan);
      const button = (label, onClick) => h('button', { className: 'btn btn-default', disabled: this.state.busy, onClick, style: { marginLeft: 8 } }, label);
      return h('div', { style: { padding: 16, overflowY: 'auto', height: '100%' } },
        h('h2', { style: { color: colour[vm.effect] || 'inherit' } }, vm.verdict),
        h('div', null,
          button('Re-check', () => this.refresh()),
          button('Install core frameworks (GitHub, 0 clicks)', () =>
            this.run((root) => runPreflight(['install', 'core', '--game', root, '--apply', '--json'], INSTALL_TIMEOUT_MS), () => 'Core frameworks installed; undo is in the journal.')),
          button('Undo last fix', () => this.run(undoLast, (j) => (j ? `Undid ${j.fix_id}.` : 'Nothing to undo.')))),
        this.state.error ? h('p', { style: { color: colour.block } }, this.state.error) : null,
        this.state.note ? h('p', null, this.state.note) : null,
        vm.actions.length ? h('h3', null, 'What to do') : null,
        h('ol', null, vm.actions.map((a, i) => h('li', { key: i, style: { marginBottom: 6 } },
          h('span', { style: { color: colour[a.effect], fontWeight: 'bold', marginRight: 6 } }, a.effect.toUpperCase()),
          a.title,
          a.count > 1 ? ` (fixes ${a.count} problems)` : '',
          a.fixId ? button('Fix', () => this.run((root) => applyFix(root, a.fixId), () => `Applied ${a.fixId}.`)) : null))),
        vm.board ? h('div', null,
          h('h3', null, `Patch-day board: ${vm.board.title}`),
          h('table', { className: 'table' }, h('tbody', null, vm.board.rows.map((r) => h('tr', { key: r.name },
            h('td', null, r.name), h('td', null, r.version), h('td', null, r.status.replace('_', ' ')),
            h('td', null, r.newest ? `newest for this patch: ${r.newest}` : '')))))) : null,
        vm.findings.length ? h('h3', null, 'Why') : null,
        vm.findings.map((f) => h('details', { key: f.id, style: { marginBottom: 6 } },
          h('summary', null, h('span', { style: { color: colour[f.effect], marginRight: 6 } }, f.effect.toUpperCase()), f.title),
          h('ul', null, f.chain.map((line, i) => h('li', { key: i }, line))))));
    }
  }
  return PreflightPage;
}

function main(context) {
  const api = context.api;
  const checks = [
    { id: 'preflight-frameworks', name: 'Preflight: frameworks', description: 'Framework and plugin versions for this patch', command: 'scan' },
    { id: 'preflight-environment', name: 'Preflight: environment', description: 'Store, build, layout and patch-day checks', command: 'scan' },
    { id: 'preflight-logs', name: 'Preflight: logs', description: 'What the last launch said went wrong', command: 'diagnose' },
  ];
  for (const spec of checks) context.registerHealthCheck(makeCheck(api, spec));

  if (context.registerStartHook) {
    context.registerStartHook(50, 'preflight-check', (input) => preLaunch(api, input));
  }

  const onAsync = api.onAsync ? api.onAsync.bind(api) : (name, handler) => api.events.on(name, handler);
  onAsync('did-deploy', (profileId) => afterDeploy(api, profileId));

  if (context.registerMainPage) {
    try {
      context.registerMainPage('health', 'Preflight', makePage(api), {
        group: 'per-game',
        visible: () => activeGame(api.getState()) === GAME_ID,
      });
    } catch (err) {
      // No React available (tests, or a Vortex without the main-page API): the report dialog still works.
    }
  }

  context.registerAction('mod-icons', 90, 'report', { pinned: false }, 'Preflight report', () => {
    showReport(api).catch((err) => (api.showErrorNotification ? api.showErrorNotification('Preflight', err) : console.error(err)));
  });

  return true;
}

module.exports = {
  default: main,
  GAME_ID,
  FIX_ORDER,
  exitToStatus,
  severityFor,
  parseScan,
  familyOf,
  findingsFor,
  blockFindings,
  fixIdsFor,
  verdictLine,
  summarise,
  toHealthResult,
  viewModel,
  gameOfProfile,
  activeGame,
  lastUndoable,
  preLaunch,
  afterDeploy,
};
