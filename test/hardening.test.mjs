/**
 * The second round of release hardening: each test pins a way chaff could have removed or
 * stopped something that was not its to touch.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, applyPlan, classify, markTracked, sameProcess, DEFAULTS } from '../scripts/chaff.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');
const cfg = { ...DEFAULTS, protect: [] };
const temps = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const scanWith = ({ projects = [], processes = [] } = {}) => ({
  schema: 2, scannedAt: new Date().toISOString(), roots: ['/repo'],
  disk: { totalGb: 100, usedGb: 50, freeGb: 50, pctUsed: 50 },
  totals: { nodeProcs: 0, nodeRssMb: 0, claudeProcs: 0, daemons: 0, projects: projects.length,
            worktrees: 0, cacheMb: 0, outputMb: 0, storeMb: 0 },
  projects, stores: [], worktrees: [], orphanArtifacts: [], processes,
});
const project = (o) => ({ root: process.cwd(), name: 'p', kinds: ['git'], exists: true, isWorktree: false,
  artifacts: [], cacheMb: 0, outputMb: 0, nodeModulesMb: null, nxVersion: null, lastCommitDays: 90,
  procCount: 0, rssMb: 0, daemons: [], active: false, live: false, ...o });

// ── committed directories are source, whatever they are called ─────────────

test('markTracked flags a build/ that git tracks and leaves untracked output alone', () => {
  const repo = tmp('chaff-tracked-');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(path.join(repo, 'build')); writeFileSync(path.join(repo, 'build', 'Dockerfile'), 'FROM x\n');
  mkdirSync(path.join(repo, 'dist')); writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'x\n');
  writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const arts = [{ path: path.join(repo, 'build') }, { path: path.join(repo, 'dist') }];
  markTracked(repo, arts);
  assert.equal(arts[0].tracked, true, 'committed build/ is source');
  assert.equal(arts[1].tracked, undefined, 'ignored dist/ is output');
});

test('a tracked artifact is never planned at any tier', () => {
  const a = { path: process.cwd() + '/build', tool: 'build', category: 'output', sizeMb: 900,
              lastWriteSec: 400 * 86400, tracked: true };
  const plan = buildPlan(scanWith({ projects: [project({ artifacts: [a] })] }), cfg);
  assert.equal(plan.actions.filter((x) => x.target === a.path).length, 0);
});

// ── age alone condemns dev tooling, not apps ─────────────────────────────────

test('a bare java process is an app, not a build daemon', () => {
  assert.equal(classify('/usr/bin/java -jar target/app.jar'), 'java');
  assert.equal(classify('java -Xmx2g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.5'), 'jvm');
});

for (const [type, cmd] of [['java', 'java -jar app.jar'], ['python', 'python3 -m jupyter lab'],
                           ['dotnet', 'dotnet run'], ['rust', 'cargo run --release'], ['unity', '/Applications/Unity.app/Contents/MacOS/Unity']]) {
  test(`a long-running ${type} process is never stopped for its age`, () => {
    const plan = buildPlan(scanWith({
      projects: [project()],
      processes: [{ pid: 4242, ppid: 1, rssMb: 900, cpu: 0, ageSec: 30 * 86400, cmd, type, project: process.cwd() }],
    }), cfg);
    assert.equal(plan.actions.filter((a) => a.pid === 4242).length, 0);
  });
}

// ── a pid is only signalled while it is still the process that was planned ──

test('sameProcess matches the planned command and nothing else', () => {
  const read = (cmd) => () => cmd;
  assert.equal(sameProcess('1', 'node a.js', read('node a.js')), true);
  assert.equal(sameProcess('1', 'node a.js --port 3000', read('node a.js')), true, 'truncated reading');
  assert.equal(sameProcess('1', 'node a.js', read('/usr/bin/vim notes.md')), false, 'reused pid');
  assert.equal(sameProcess('1', 'node a.js', read('')), false, 'gone');
  assert.equal(sameProcess('1', undefined, read('node a.js')), false, 'nothing recorded');
});

/** A detached `sleep`, reparented to init — like a real abandoned process, not our child. */
const orphanSleep = (secs) => +execFileSync('sh', ['-c', `sleep ${secs} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('applyPlan will not kill a pid that now belongs to a different process', { skip: process.platform === 'win32' }, () => {
  const pid = orphanSleep(60);
  try {
    const action = { tier: 1, kind: 'kill', target: '/repo/gone', pid, reclaimMb: 1,
                     reason: 'test', cmd: ['kill', '-TERM', String(pid)], expect: { [pid]: 'node dev-server.js' } };
    const [r] = applyPlan({ actions: [action] }, { maxTier: 1, dryRun: false });
    assert.equal(r.status, 'skipped');
    assert.match(r.note, /different process/);
    assert.ok(alive(pid), 'the unrelated process must still be alive');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('applyPlan still kills the process it planned to', { skip: process.platform === 'win32' }, () => {
  const pid = orphanSleep(61);
  try {
    const action = { tier: 1, kind: 'kill', target: '/repo/gone', pid, reclaimMb: 1,
                     reason: 'test', cmd: ['kill', '-TERM', String(pid)], expect: { [pid]: 'sleep 61' } };
    const [r] = applyPlan({ actions: [action] }, { maxTier: 1, dryRun: false });
    assert.equal(r.status, 'done', r.note);
    assert.ok(!alive(pid));
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('buildPlan records what every pid in a kill was', () => {
  const plan = buildPlan(scanWith({
    processes: [{ pid: 777, ppid: 1, rssMb: 10, cpu: 0, ageSec: 99, cmd: 'node nx/bin/nx.js daemon', type: 'nx-daemon', project: '/repo/gone' }],
  }), cfg);
  const kill = plan.actions.find((a) => a.pid === 777);
  assert.ok(kill, 'dead project daemon is tier 1');
  assert.deepEqual(kill.expect, { 777: 'node nx/bin/nx.js daemon' });
});

// ── CLI edges ────────────────────────────────────────────────────────────────

const cli = (home, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 30_000, cwd: home, env: { ...process.env, CHAFF_HOME: home, CI: '' },
});

test('chaff ci refuses off a CI runner without --yes', () => {
  const r = cli(tmp('chaff-ci-'), 'ci');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /meant for CI runners/);
});

test('a string where a list belongs in config is read as a one-item list, not a crash', () => {
  const home = tmp('chaff-cfg-');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: '~/code', protect: 'secret' }));
  const r = cli(home, 'config', '--json');
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.deepEqual(c.roots, ['~/code']);
  assert.deepEqual(c.protect, ['secret']);
});

test('a non-list roots value is ignored with a warning', () => {
  const home = tmp('chaff-cfg-');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: 5 }));
  const r = cli(home, 'config', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /must be a list/);
});

test('a worktree with only a shell sitting in it counts as in use', { skip: process.platform === 'win32' }, () => {
  // Toolchain attribution never sees a shell or an editor; their cwd is the only signal
  // that someone is working there.
  const root = tmp('chaff-wt-root-');
  const home = tmp('chaff-wt-home-');
  const repo = path.join(root, 'app');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'init');
  const wt = path.join(root, 'app-wt');
  git('worktree', 'add', '-q', '-b', 'feat', wt);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [root] }));
  // Outlives the scan: a cold one sizes every machine-wide store first, which takes a while.
  const sitter = spawn('sleep', ['900'], { cwd: wt, detached: true, stdio: 'ignore' });
  sitter.unref();
  const pid = sitter.pid;
  try {
    const r = spawnSync(process.execPath, [CLI, 'scan', '--fresh', '--json'], {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, CHAFF_HOME: home }, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.stderr);
    const real = execFileSync('git', ['-C', wt, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const found = JSON.parse(r.stdout).worktrees.find((w) => w.path === real || w.path === wt);
    assert.ok(found, 'worktree is scanned');
    assert.equal(found.hasProcess, true, 'a shell in the worktree means someone is working there');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});
