/**
 * Native Windows has no find/du/df/ps, so chaff brings its own scan layer there: a Node
 * filesystem walk, PowerShell for processes, statfs for disk. Acting has a Windows half too:
 * trash by rename (copy-and-verify across volumes), never delete what is held open, taskkill
 * only after the pid's identity is re-checked, and package-manager shims through cmd.exe with
 * constant arguments only.
 *
 * The walk is checked against real `find` and `du` on macOS and Linux, so its semantics are
 * pinned where the reference exists. The CLI tests run "as Windows": on macOS and Linux by
 * forcing process.platform before chaff.mjs loads, and on the windows-latest CI job for real,
 * which is what actually proves it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync, existsSync, readFileSync, readdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  walkProjectMarkers, walkArtifacts, walkDeps, treeBytes, projectFromWinCmd,
  buildPlan, DEFAULTS, removeTree, moveByCopy, treeDiff, winCommand, sameWinProcess, schtasksSpec,
  applyPlan, winProcInfo,
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

test('a mistyped command on Windows is reported as unknown, and does nothing', () => {
  const r = asWindows(['some-future-command'], { env: { CHAFF_HOME: state } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown subcommand: some-future-command/);
});

test('help and config still work on Windows', () => {
  const h = asWindows(['help']);
  assert.equal(h.status, 0, `help must work: ${h.stderr}`);
  assert.match(h.stdout, /chaff/);
  const c = asWindows(['config'], { env: { CHAFF_HOME: state } });
  assert.equal(c.status, 0, `config must work: ${c.stderr}`);
  JSON.parse(c.stdout);
});

test('MCP chaff_clean on Windows follows the same consent flow: no planId, dry run only', () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_clean', arguments: { tier: 1, confirm: true } } },
  ];
  const r = asWindows(['mcp'], { env: { CHAFF_HOME: state }, input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n' });
  const replies = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const res = replies.find((m) => m.id === 2);
  assert.ok(res, `no reply to chaff_clean:\n${r.stdout}\n${r.stderr}`);
  assert.match(res.result.content[0].text, /DRY RUN/);
});

test('dry runs of every cleanup command run on Windows and change nothing', () => {
  for (const args of [['reap', '--dry-run'], ['apply', '--dry-run'], ['clean', '--tier=2', '--dry-run']]) {
    const r = asWindows(args, { env: { CHAFF_HOME: state } });
    assert.equal(r.status, 0, `${args.join(' ')} should run on Windows (${r.status}):\n${r.stderr}`);
  }
  for (const want of ['rust-app/target', 'dotnet-app/obj', 'web/.next']) {
    assert.ok(existsSync(path.join(root, ...want.split('/'))), `${want} must survive a dry run`);
  }
});

// ── acting, all platforms: the pieces Windows cleanup is built from ─────────────

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const hashTree = (dir) => {
  const h = createHash('sha256');
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const full = path.join(d, n), r = `${rel}/${n}`;
      if (statSync(full).isDirectory()) { h.update(`d:${r}`); walk(full, r); }
      else { h.update(`f:${r}`); h.update(readFileSync(full)); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
};

test('removeTree removes a link inside the tree, never what it points at', () => {
  const t = tmp('chaff-rt-');
  const keep = path.join(t, 'keep');
  mkdirSync(keep); writeFileSync(path.join(keep, 'precious.txt'), 'do not delete');
  const doomed = path.join(t, 'doomed', 'nested');
  mkdirSync(doomed, { recursive: true });
  writeFileSync(path.join(doomed, 'f.bin'), Buffer.alloc(1024, 7));
  symlinkSync(keep, path.join(t, 'doomed', 'link'), WIN ? 'junction' : 'dir');
  removeTree(path.join(t, 'doomed'));
  assert.ok(!existsSync(path.join(t, 'doomed')), 'the tree is gone');
  assert.equal(readFileSync(path.join(keep, 'precious.txt'), 'utf8'), 'do not delete', 'the link target is untouched');
  rmSync(t, { recursive: true, force: true });
});

test('moveByCopy copies, verifies, then removes the source; the copy is byte-identical', () => {
  const t = tmp('chaff-mbc-');
  const src = path.join(t, 'target');
  mkdirSync(path.join(src, 'deep', 'er'), { recursive: true });
  writeFileSync(path.join(src, 'a.bin'), Buffer.alloc(300 * 1024, 3));
  writeFileSync(path.join(src, 'deep', 'er', 'b.txt'), 'hello');
  const before = hashTree(src);
  const dest = moveByCopy(src, path.join(t, 'trash-entry'), { origin: src });
  assert.ok(!existsSync(src));
  assert.equal(hashTree(dest), before);
  assert.equal(readFileSync(dest + '.origin', 'utf8'), src);
  rmSync(t, { recursive: true, force: true });
});

test('treeDiff notices a missing or resized file', () => {
  const t = tmp('chaff-td-');
  mkdirSync(path.join(t, 'a')); mkdirSync(path.join(t, 'b'));
  writeFileSync(path.join(t, 'a', 'x'), '123'); writeFileSync(path.join(t, 'b', 'x'), '123');
  assert.equal(treeDiff(path.join(t, 'a'), path.join(t, 'b')), null);
  writeFileSync(path.join(t, 'b', 'x'), '12');
  assert.match(treeDiff(path.join(t, 'a'), path.join(t, 'b')), /x: file:3 vs file:2/);
  rmSync(t, { recursive: true, force: true });
});

test('Windows commands: rm and kill run natively, shims go through cmd.exe with plain words only', () => {
  assert.deepEqual(winCommand('rm', ['-rf', 'C:\\x\\target']), { internal: 'rm', target: 'C:\\x\\target' });
  assert.deepEqual(winCommand('kill', ['-TERM', '12', '34']), { internal: 'kill', pids: [12, 34] });
  const npm = winCommand('npm', ['cache', 'clean', '--force']);
  assert.deepEqual(npm.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(npm.args[3], 'npm cache clean --force');
  assert.equal(npm.verbatim, true);
  assert.deepEqual(winCommand('git', ['-C', 'C:\\r', 'worktree', 'prune']), { file: 'git', args: ['-C', 'C:\\r', 'worktree', 'prune'] });
  for (const evil of [['cache', 'clean', '&', 'del', 'x'], ['a"b'], ['%PATH%'], ['x|y']]) {
    assert.throws(() => winCommand('npm', evil), /refusing to run/);
  }
});

test('a recycled pid is never mistaken for the planned process', () => {
  const start = Date.now() - 60_000;
  const info = { cmd: 'node C:\\app\\node_modules\\vite\\bin\\vite.js', startMs: start + 1500 };
  assert.equal(sameWinProcess(info, info.cmd, start), true, 'same command, start within tolerance');
  assert.equal(sameWinProcess(info, info.cmd, start - 10 * 60_000), false, 'same command line, started minutes apart');
  assert.equal(sameWinProcess({ ...info, cmd: 'node' }, info.cmd, start), false, 'different command');
  assert.equal(sameWinProcess(null, info.cmd, start), false, 'gone');
  assert.equal(sameWinProcess(info, undefined, start), false, 'nothing recorded');
});

test('schtasks: a daily task running a wrapper, tier 1-2 only, unsafe paths refused', () => {
  const sp = schtasksSpec(3, 2, { exe: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\c\\scripts\\chaff.mjs', log: 'C:\\h\\.chaff\\nightly.log', home: 'C:\\h\\.chaff' });
  assert.deepEqual(sp.args, ['/Create', '/F', '/SC', 'DAILY', '/TN', 'tools.chaff.nightly', '/ST', '03:00', '/TR', '"C:\\h\\.chaff\\nightly.cmd"']);
  assert.equal(sp.wrapperBody,
    '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\c\\scripts\\chaff.mjs" clean --tier=2 --yes --fresh >> "C:\\h\\.chaff\\nightly.log" 2>&1\r\n');
  const ok = { exe: 'C:\\n.exe', script: 'C:\\s.mjs', log: 'C:\\l', home: 'C:\\h' };
  assert.throws(() => schtasksSpec(3, 3, ok), /tier 1 or 2/);
  assert.throws(() => schtasksSpec(24, 2, ok), /0-23/);
  assert.throws(() => schtasksSpec(3, 2, { ...ok, home: 'C:\\Users\\100%\\x' }), /" or %/);
});

// ── acting, for real, on the windows-latest runner ────────────────────────────

test('Windows: a real clean trashes a stale artifact, skips a held one, and restore is byte-exact', { skip: !WIN && 'Windows only' }, async () => {
  // The fixture lives on the runner's work drive (D:) when it has one, and chaff's trash on
  // C:, so the move crosses volumes the way repos-on-D: machines do.
  const base = process.env.RUNNER_TEMP && path.parse(process.env.RUNNER_TEMP).root !== path.parse(tmpdir()).root
    ? process.env.RUNNER_TEMP : tmpdir();
  const fx = realpathSync(mkdtempSync(path.join(base, 'chaff-clean-')));
  const home = tmp('chaff-clean-home-');
  const mkStale = (rel, files) => {
    const d = path.join(fx, ...rel.split('/'));
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
    const old = new Date(Date.now() - 30 * 86400_000);
    for (const f of readdirSync(d)) utimesSync(path.join(d, f), old, old);
    utimesSync(d, old, old);
    return d;
  };
  mkdirSync(path.join(fx, 'old-app', '.git'), { recursive: true });
  writeFileSync(path.join(fx, 'old-app', 'Cargo.toml'), 'x');
  const target = mkStale('old-app/target', { 'a.bin': Buffer.alloc(1100 * 1024, 5), 'b.txt': 'build output' });
  mkdirSync(path.join(fx, 'held-app', '.git'), { recursive: true });
  writeFileSync(path.join(fx, 'held-app', 'Cargo.toml'), 'x');
  const held = mkStale('held-app/target', { 'c.bin': Buffer.alloc(1100 * 1024, 6) });
  const before = hashTree(target);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    roots: [fx], maxScanDepth: 4, maxArtifactDepth: 4, staleArtifactDays: 1, autoStatusline: false, updateCheck: false,
    thresholds: { storeGb: 100000, daemons: 1000, nodeRssMb: 10_000_000 },
  }));
  // A process whose working directory is inside held-app/target holds it open: Windows will
  // not rename it, and chaff must leave it exactly where it is.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: held, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = spawnSync(process.execPath, [CLI, 'clean', '--tier=2', '--yes', '--fresh', '--json'],
      { encoding: 'utf8', timeout: 180_000, env: { ...process.env, CI: '', CHAFF_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const results = JSON.parse(r.stdout).results ?? JSON.parse(r.stdout);
    const of = (p) => results.find((x) => x.target === p);
    assert.equal(of(target)?.status, 'done', JSON.stringify(results, null, 1));
    assert.ok(!existsSync(target), 'the stale target/ was moved away');
    assert.equal(of(held)?.status, 'skipped', JSON.stringify(of(held)));
    assert.match(of(held).note, /in use/);
    assert.equal(readFileSync(path.join(held, 'c.bin')).length, 1100 * 1024, 'the held directory is untouched');

    const id = path.basename(of(target).trash);
    const rr = spawnSync(process.execPath, [CLI, 'restore', id], { encoding: 'utf8', env: { ...process.env, CI: '', CHAFF_HOME: home } });
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    assert.equal(hashTree(target), before, 'restored byte for byte');
  } finally {
    // The holder keeps held-app/target open until it has actually exited.
    if (holder.exitCode === null) { const gone = new Promise((r) => holder.once('exit', r)); holder.kill(); await gone; }
    rmSync(fx, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('Windows: taskkill only after the pid is re-checked, and a mismatch is left alone', { skip: !WIN && 'Windows only' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  try {
    const info = winProcInfo(child.pid);
    assert.ok(info?.cmd, 'Win32_Process reports the child');
    const action = (expectStart) => ({ actions: [{
      tier: 1, kind: 'kill', pid: child.pid, target: 'test', reclaimMb: 0,
      cmd: ['kill', '-TERM', String(child.pid)], expect: { [child.pid]: info.cmd }, expectStart: { [child.pid]: expectStart },
    }] });
    const [stale] = applyPlan(action(info.startMs - 10 * 60_000), { maxTier: 1, dryRun: false });
    assert.equal(stale.status, 'skipped');
    assert.match(stale.note, /different process/);
    assert.ok(alive(), 'a start-time mismatch must not be killed');
    const [real] = applyPlan(action(info.startMs), { maxTier: 1, dryRun: false });
    assert.equal(real.status, 'done', JSON.stringify(real));
    assert.ok(!alive(), 'the verified process is gone');
  } finally { try { child.kill(); } catch { /* gone */ } }
});

test('Windows: schedule --install registers a daily task and --uninstall removes it', { skip: !WIN && 'Windows only' }, () => {
  const home = tmp('chaff-sched-');
  const env = { ...process.env, CI: '', CHAFF_HOME: home };
  try {
    const i = spawnSync(process.execPath, [CLI, 'schedule', '--install', '--hour=4'], { encoding: 'utf8', env });
    assert.equal(i.status, 0, i.stderr);
    assert.doesNotMatch(i.stdout, /failed/, i.stdout);
    assert.ok(existsSync(path.join(home, 'nightly.cmd')));
    const q = spawnSync('schtasks', ['/Query', '/TN', 'tools.chaff.nightly'], { encoding: 'utf8' });
    assert.equal(q.status, 0, q.stderr);
  } finally {
    spawnSync(process.execPath, [CLI, 'schedule', '--uninstall'], { encoding: 'utf8', env });
    rmSync(home, { recursive: true, force: true });
  }
  assert.notEqual(spawnSync('schtasks', ['/Query', '/TN', 'tools.chaff.nightly'], { encoding: 'utf8' }).status, 0, 'task removed');
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
