/**
 * Native Windows has no find/du/df/ps, so chaff brings its own scan layer there: a Node
 * filesystem walk, PowerShell for processes, statfs for disk. Phase 1 of #16 makes that layer
 * read-only — reporting runs, and every command that acts still refuses.
 *
 * The walk is checked against real `find` and `du` on macOS and Linux, so its semantics are
 * pinned where the reference exists. The CLI tests run "as Windows": on macOS and Linux by
 * forcing process.platform before chaff.mjs loads, and on the windows-latest CI job for real,
 * which is what actually proves it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  walkProjectMarkers, walkArtifacts, walkDeps, treeBytes, projectFromWinCmd,
  buildPlan, DEFAULTS,
} from '../scripts/chaff.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');
const WIN = process.platform === 'win32';

/** Run the CLI with process.platform forced to win32, before chaff.mjs is evaluated. */
const asWindows = (args, { env = {}, input } = {}) => {
  const harness = `
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.argv = [process.argv[0], ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(pathToFileURL(CLI).href)});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    // HOME (POSIX) points at the temp state dir, so faked runs do not size this machine's real
    // package stores (pnpm finds its store through PNPM_HOME, not HOME); on Windows homedir()
    // reads USERPROFILE and the runner's stores are small.
    encoding: 'utf8', timeout: 120_000, input,
    env: { ...process.env, CI: '', HOME: state, PNPM_HOME: state, XDG_DATA_HOME: state, XDG_CACHE_HOME: state, ...env },
  });
};

// ── fixture ───────────────────────────────────────────────────────────────────

let root, state;
const rel = (hits) => hits.map((h) => path.relative(root, h).split(path.sep).join('/')).sort();
const MB = 1024 * 1024;

before(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'chaff-win-')));
  state = mkdtempSync(path.join(tmpdir(), 'chaff-win-state-'));
  const mk = (r, files = {}) => {
    const d = path.join(root, r);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
    return d;
  };
  // real projects, each with a gated artifact that must be counted
  mk('rust-app', { 'Cargo.toml': 'x' });
  mk('rust-app/target', { 'out.bin': Buffer.alloc(2 * MB, 1) });
  mk('dotnet-app', { 'App.sln': 'x' });
  mk('dotnet-app/obj', { 'o.dll': Buffer.alloc(1 * MB, 1) });
  mk('web/.git');
  mk('web/.next', { 'page.js': Buffer.alloc(1 * MB, 1) });
  mk('web/node_modules/dep', { 'nx.json': 'inside node_modules: pruned' });
  mk('web/node_modules/dep/build');                 // never seen: node_modules is pruned
  mk('web/dist/.cache');                            // dist is pruned once matched, so .cache inside is not listed
  mk('web/packages/a/node_modules');                // a second install, found by walkDeps
  // decoys — same names, no marker
  mk('notes/target', { 'readme.txt': 'mine' });
  mk('notes/obj');
  // too deep for maxDepth 4
  mk('deep/a/b/c/d/Cargo.toml-dir/.git');
  // a link back up the tree must not be followed (junction on Windows: no admin needed)
  try { symlinkSync(root, path.join(root, 'web', 'loop'), WIN ? 'junction' : 'dir'); } catch { /* best effort */ }

  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    roots: [root], sizeMode: 'full', maxScanDepth: 4, maxArtifactDepth: 4,
  }));
});
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });

// ── walk semantics, pinned against find(1) ───────────────────────────────────

const find = (args) => execFileSync('find', [root, ...args], { encoding: 'utf8' }).split('\n').filter(Boolean);

test('project markers: the walk finds what find finds', () => {
  const got = rel(walkProjectMarkers(root, 4));
  assert.deepEqual(got, ['dotnet-app/App.sln', 'rust-app/Cargo.toml', 'web/.git']);
  if (!WIN) {
    const names = ['nx.json', 'Cargo.toml', '*.sln', '.git'];
    const args = ['-maxdepth', '4', '-name', 'node_modules', '-prune', '-o', '('];
    names.forEach((n, i) => { if (i) args.push('-o'); args.push('-name', n); });
    args.push(')', '-print');
    assert.deepEqual(rel(walkProjectMarkers(root, 4, names)), rel(find(args)));
  }
});

test('artifacts: real directories only, node_modules pruned, matches pruned', () => {
  const names = ['target', 'obj', '.next', 'dist', '.cache', 'build'];
  const got = rel(walkArtifacts(root, 4, names));
  assert.deepEqual(got, ['dotnet-app/obj', 'notes/obj', 'notes/target', 'rust-app/target', 'web/.next', 'web/dist']);
  if (!WIN) {
    const args = ['-maxdepth', '4', '-name', 'node_modules', '-prune', '-o', '-type', 'd', '('];
    names.forEach((n, i) => { if (i) args.push('-o'); args.push('-name', n); });
    args.push(')', '-print', '-prune');
    assert.deepEqual(got, rel(find(args)));
  }
});

test('node_modules: each install once, and a link is never followed', () => {
  const got = rel(walkDeps(root, 4));
  assert.deepEqual(got, ['web/node_modules', 'web/packages/a/node_modules']);
  if (!WIN) {
    assert.deepEqual(got, rel(find(['-maxdepth', '4', '-type', 'd', '-name', 'node_modules', '-print', '-prune'])));
  }
});

test('treeBytes counts like du: links not followed, hard links once', () => {
  const d = path.join(root, 'sizing');
  mkdirSync(d);
  writeFileSync(path.join(d, 'a'), Buffer.alloc(3 * MB, 1));
  linkSync(path.join(d, 'a'), path.join(d, 'a-hardlink'));
  try { symlinkSync(path.join(root, 'rust-app'), path.join(d, 'link'), WIN ? 'junction' : 'dir'); } catch { /* best effort */ }
  const bytes = treeBytes(d);
  assert.ok(bytes >= 3 * MB && bytes < 3.2 * MB, `expected ~3MB, got ${bytes}`);
  if (!WIN) {
    const kb = +execFileSync('du', ['-sk', d], { encoding: 'utf8' }).split(/\s+/)[0];
    assert.ok(Math.abs(kb * 1024 - bytes) < 0.1 * bytes, `du says ${kb}KB, walk says ${bytes}B`);
  }
  rmSync(d, { recursive: true, force: true });
});

test('a Windows command line yields the project that holds its node_modules', () => {
  assert.equal(projectFromWinCmd('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jo Smith\\app\\node_modules\\nx\\bin\\nx.js" serve'),
    'C:\\Users\\Jo Smith\\app');
  assert.equal(projectFromWinCmd('node c:/repos/web/node_modules/vite/bin/vite.js'), 'C:\\repos\\web');
  assert.equal(projectFromWinCmd('"C:\\a\\node.exe" C:\\repos\\api\\node_modules\\.bin\\tsc --watch'), 'C:\\repos\\api');
  assert.equal(projectFromWinCmd('node .\\node_modules\\x\\cli.js'), null, 'a relative path names no project');
  assert.equal(projectFromWinCmd('C:\\Windows\\System32\\svchost.exe -k netsvcs'), null);
});

// ── the CLI, as Windows ──────────────────────────────────────────────────────

const json = (args) => {
  const r = asWindows([...args, '--json'], { env: { CHAFF_HOME: state } });
  assert.equal(r.status, 0, `${args.join(' ')} failed (${r.status}):\n${r.stderr}`);
  return JSON.parse(r.stdout);
};

test('a scan runs on Windows and finds real projects, gated artifacts and sizes', () => {
  const s = json(['scan', '--fresh']);
  const arts = s.projects.flatMap((p) => p.artifacts).map((a) => ({ ...a, rel: path.relative(root, a.path).split(path.sep).join('/') }));
  const by = Object.fromEntries(arts.map((a) => [a.rel, a]));
  for (const want of ['rust-app/target', 'dotnet-app/obj', 'web/.next']) {
    assert.ok(by[want], `${want} should be found; got ${Object.keys(by)}`);
    assert.ok(by[want].sizeMb >= 1, `${want} should be sized, got ${by[want].sizeMb}MB`);
  }
  for (const decoy of ['notes/target', 'notes/obj']) {
    assert.ok(!arts.some((a) => a.rel === decoy) && !s.orphanArtifacts.some((a) => a.path.endsWith(decoy.replace('/', path.sep))),
      `${decoy} has no marker and must not be counted`);
  }
  assert.ok(s.disk.totalGb > 0, `disk total should be known, got ${JSON.stringify(s.disk)}`);
  assert.ok(s.projects.some((p) => p.nodeModulesMb !== null), 'node_modules measured with sizeMode full');
  if (WIN) assert.ok(s.processes.length > 0, 'PowerShell should report processes on Windows');
});

test('plan, doctor, top, worktrees and status run on Windows', () => {
  const plan = json(['plan']);
  assert.ok(Array.isArray(plan.actions));
  for (const sub of ['doctor', 'top', 'worktrees', 'status', 'statusline']) {
    const r = asWindows([sub], { env: { CHAFF_HOME: state } });
    assert.equal(r.status, 0, `${sub} should run on Windows (${r.status}):\n${r.stderr}`);
  }
});

test('every command that acts still refuses on Windows, before scanning', () => {
  for (const args of [
    ['reap'], ['reap', '--dry-run'], ['clean', '--tier=2', '--yes'], ['apply', '--dry-run'],
    ['ci', '--yes'], ['restore', 'some-id'], ['trash', '--empty'],
    ['schedule', '--install'], ['schedule', '--uninstall'], ['statusline', '--install'],
    ['some-future-command'],
  ]) {
    const r = asWindows(args, { env: { CHAFF_HOME: state } });
    assert.equal(r.status, 4, `${args.join(' ')} must exit 4 on Windows, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /cleanup on native Windows is not enabled yet — run it in WSL; see #16/);
  }
});

test('the refusal says what works and what to do instead', () => {
  const { stderr } = asWindows(['clean']);
  assert.match(stderr, /chaff status, chaff plan/);
  assert.match(stderr, /wsl/i);
  assert.match(stderr, /\/mnt\/c/, 'must warn that scanning /mnt/c is not worth doing');
});

test('help and config still work on Windows', () => {
  const h = asWindows(['help']);
  assert.equal(h.status, 0, `help must work: ${h.stderr}`);
  assert.match(h.stdout, /chaff/);
  const c = asWindows(['config'], { env: { CHAFF_HOME: state } });
  assert.equal(c.status, 0, `config must work: ${c.stderr}`);
  JSON.parse(c.stdout);
});

test('MCP chaff_clean refuses on Windows without asking anyone to approve anything', () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_clean', arguments: { tier: 1, confirm: true } } },
  ];
  const r = asWindows(['mcp'], { env: { CHAFF_HOME: state }, input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n' });
  const replies = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(!replies.some((m) => m.method === 'elicitation/create'), 'must not prompt the user');
  const res = replies.find((m) => m.id === 2);
  assert.ok(res, `no reply to chaff_clean:\n${r.stdout}\n${r.stderr}`);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not enabled yet/);
});

test('paths are grouped without assuming a forward slash', () => {
  // The cargo-duplication check keys on the last few path segments. On Windows those arrive
  // backslash-separated, and a naive split('/') would put every target/ in one bucket.
  const art = (p) => ({ path: p, tool: 'cargo/maven', sizeMb: 900, kind: 'output', exists: true });
  const proj = (name, r) => ({
    name, path: r, exists: true, ageDays: 1, lastTouched: Date.now(),
    artifacts: [art(r + '\\src-tauri\\target')], active: false, cacheMb: 0, outputMb: 900,
  });
  const s = {
    schema: 2, scannedAt: new Date().toISOString(), roots: ['C:\\repos'],
    disk: { totalGb: 500, usedGb: 400, freeGb: 100, pctUsed: 80 },
    totals: { nodeProcs: 0, nodeRssMb: 0, claudeProcs: 0, daemons: 0, projects: 2,
              worktrees: 0, cacheMb: 0, outputMb: 1800, storeMb: 0 },
    projects: [proj('a', 'C:\\repos\\a'), proj('b', 'C:\\repos\\b')],
    stores: [], worktrees: [], orphanArtifacts: [], processes: [],
  };
  assert.doesNotThrow(() => buildPlan(s, { ...DEFAULTS, protect: [] }),
    'a Windows-shaped scan must not crash the planner');
});
