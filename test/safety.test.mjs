/**
 * The invariants that matter. chaff's main verb is `rm -rf`, so these guard the cases where
 * a regression would destroy someone's work rather than merely inconvenience them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, applyPlan, classify, DEFAULTS } from '../scripts/chaff.mjs';

const cfg = { ...DEFAULTS, staleWorktreeDays: 7, staleArtifactDays: 7, protect: [] };

/** A scan whose projects/worktrees all exist, so nothing lands in tier 1 by accident. */
const scanWith = ({ worktrees = [], projects = [], processes = [], stores = [] } = {}) => ({
  schema: 2, scannedAt: new Date().toISOString(), roots: ['/repo'],
  disk: { totalGb: 100, usedGb: 50, freeGb: 50, pctUsed: 50 },
  totals: { nodeProcs: 0, nodeRssMb: 0, claudeProcs: 0, daemons: 0, projects: projects.length,
            worktrees: worktrees.length, cacheMb: 0, outputMb: 0, storeMb: 0 },
  projects, stores, worktrees, orphanArtifacts: [], processes,
});

const wt = (o) => ({
  path: '/repo/.claude/worktrees/a1', repo: '/repo', branch: 'feat/x', baseBranch: 'main',
  exists: true, isPrimary: false, locked: false, prunable: false, detached: false,
  merged: true, dirty: false, hasProcess: false, ageDays: 30, cacheMb: 100, ...o,
});

const removals = (plan, tier) =>
  plan.actions.filter((a) => a.kind === 'remove-worktree' && (tier == null || a.tier === tier));

// ── the one that matters most ────────────────────────────────────────────────

test('a worktree with uncommitted changes never reaches tier 2', () => {
  const plan = buildPlan(scanWith({ worktrees: [wt({ dirty: true })] }), cfg);
  assert.equal(removals(plan, 2).length, 0, 'dirty worktree must not be tier 2');
});

test('a worktree whose cleanliness is UNKNOWN never reaches tier 2', () => {
  // isDirty() returns null on timeout. Unknown must be treated as unsafe, not as clean.
  const plan = buildPlan(scanWith({ worktrees: [wt({ dirty: null })] }), cfg);
  assert.equal(removals(plan, 2).length, 0, 'unknown dirtiness must not be tier 2');
});

test('a merged, clean, idle worktree DOES reach tier 2', () => {
  const plan = buildPlan(scanWith({ worktrees: [wt({ dirty: false, merged: true })] }), cfg);
  assert.equal(removals(plan, 2).length, 1, 'the safe case must still be offered');
});

test('an unmerged worktree never reaches tier 2, only tier 3', () => {
  const plan = buildPlan(scanWith({ worktrees: [wt({ merged: false, dirty: false })] }), cfg);
  assert.equal(removals(plan, 2).length, 0);
  assert.equal(removals(plan, 3).length, 1);
});

// ── primary checkouts are not worktrees you can remove ───────────────────────

test('a primary checkout is never proposed for removal at any tier', () => {
  const plan = buildPlan(scanWith({ worktrees: [wt({ isPrimary: true, branch: 'main', ageDays: 400 })] }), cfg);
  assert.equal(removals(plan).length, 0, 'git worktree remove cannot remove the main working copy');
});

// ── blocked entries are shown but never executed ─────────────────────────────

test('locked and in-use worktrees are flagged blocked', () => {
  for (const [o, why] of [[{ locked: true }, 'locked'], [{ hasProcess: true }, 'in use']]) {
    const plan = buildPlan(scanWith({ worktrees: [wt({ merged: false, ...o })] }), cfg);
    const a = removals(plan)[0];
    assert.ok(a, 'should still be surfaced');
    assert.equal(a.blocked, why);
  }
});

test('applyPlan never executes a blocked action, even at tier 3', () => {
  const plan = buildPlan(scanWith({ worktrees: [wt({ merged: false, locked: true })] }), cfg);
  const results = applyPlan(plan, { maxTier: 3, dryRun: false });
  assert.ok(results.length > 0);
  for (const r of results) assert.notEqual(r.status, 'done', 'a blocked action must never run');
  assert.equal(results[0].status, 'skipped');
});

test('a dry run performs nothing at all', () => {
  const plan = buildPlan(scanWith({ worktrees: [wt()] }), cfg);
  const results = applyPlan(plan, { maxTier: 3, dryRun: true });
  assert.ok(results.length > 0);
  for (const r of results) assert.equal(r.status, 'dry-run');
});

// ── the protect list is absolute ─────────────────────────────────────────────

test('protected paths are excluded from every tier', () => {
  const scan = scanWith({ worktrees: [wt({ path: '/repo/.claude/worktrees/keep-me', merged: false })] });
  const plan = buildPlan(scan, { ...cfg, protect: ['keep-me'] });
  assert.equal(plan.actions.filter((a) => a.target.includes('keep-me')).length, 0);
});

// ── tier 1 means provably dead ───────────────────────────────────────────────

test('tier 1 only contains things that no longer exist', () => {
  const scan = scanWith({
    processes: [{ pid: 999999, ppid: 1, rssMb: 100, cpu: 0, ageSec: 9999,
                  cmd: 'node x', type: 'nx-daemon', project: '/repo/definitely-not-here' }],
    worktrees: [wt({ prunable: true, exists: false })],
  });
  const plan = buildPlan(scan, cfg);
  const t1 = plan.actions.filter((a) => a.tier === 1);
  assert.ok(t1.length >= 2, 'dead process and prunable worktree both belong in tier 1');
  for (const a of t1) assert.ok(['kill', 'prune-worktree', 'rm-artifact'].includes(a.kind));
});

test('a process attributed outside the scanned roots is never a tier-1 kill', () => {
  // projectFromCmd stops at the first space: VS Code's bundled tsserver yields a fragment
  // like /Contents/Resources/app/extensions, which does not exist and read as "deleted".
  const scan = scanWith({
    processes: [{ pid: 999998, ppid: 1, rssMb: 100, cpu: 0, ageSec: 9999,
                  cmd: 'node /Applications/Visual Studio Code.app/Contents/Resources/app/extensions/node_modules/typescript/lib/tsserver.js',
                  type: 'tsserver', project: '/Contents/Resources/app/extensions' }],
  });
  assert.equal(buildPlan(scan, cfg).actions.filter((a) => a.kind === 'kill').length, 0);
});

test('a shell or editor that inherited a dead project is never a tier-1 kill', () => {
  // Attribution propagates along the process tree, so a parent zsh picks up its child's
  // project. Only toolchain processes are ours to kill.
  const scan = scanWith({
    processes: [
      { pid: 999997, ppid: 1, rssMb: 10, cpu: 0, ageSec: 9999, cmd: '-zsh', type: 'other', project: '/repo/gone' },
      { pid: 999996, ppid: 1, rssMb: 10, cpu: 0, ageSec: 9999, cmd: 'node extensionHost', type: 'node', project: '/repo/gone' },
    ],
  });
  assert.equal(buildPlan(scan, cfg).actions.filter((a) => a.kind === 'kill').length, 0);
});

test('an artifact under no recognised project is never tier 1 or 2', () => {
  // No marker above it means chaff cannot tell who owns it — not that the owner is dead.
  const scan = { ...scanWith(), orphanArtifacts: [
    { path: '/repo/clients/acme/build', tool: 'build', category: 'output', sizeMb: 500, lastWriteSec: 90 * 86400 },
  ] };
  const acts = buildPlan(scan, cfg).actions.filter((a) => a.target === '/repo/clients/acme/build');
  assert.equal(acts.length, 1, 'still surfaced');
  assert.equal(acts[0].tier, 3, 'but only as a tier-3 decision for a person');
});

test('a live project is never killed', () => {
  const scan = scanWith({
    projects: [{ root: process.cwd(), name: 'live', kinds: ['git'], exists: true, isWorktree: false,
                 artifacts: [], cacheMb: 0, outputMb: 0, nodeModulesMb: null, nxVersion: null,
                 lastCommitDays: 0, procCount: 1, rssMb: 100, daemons: [], active: true, live: true }],
    processes: [{ pid: 1, ppid: 0, rssMb: 100, cpu: 0, ageSec: 10, cmd: 'node x',
                  type: 'nx-run', project: process.cwd() }],
  });
  const plan = buildPlan(scan, cfg);
  assert.equal(plan.actions.filter((a) => a.kind === 'kill').length, 0);
});

// ── tiers are ordered and additive ───────────────────────────────────────────

test('actions are sorted by tier, so --tier=N is a strict prefix', () => {
  const scan = scanWith({
    worktrees: [wt({ prunable: true, exists: false }), wt({ path: '/repo/w2', dirty: false }),
                wt({ path: '/repo/w3', merged: false })],
  });
  const tiers = buildPlan(scan, cfg).actions.map((a) => a.tier);
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
});

// ── abandoned work is not work in flight ─────────────────────────────────────
//
// Dev servers and test runners are classified as work, and work used to be exempt from
// every tier: the only kill path was tier 1, which fires solely when the project directory
// is gone. A `next dev` left running for a week in a live repo was unreachable, and worse,
// it marked its project active, which held that project's artifacts out of tier 2 as well.

// The project root must really exist, or tier 1 claims its processes as dead first.
const REPO = process.cwd();

const proj = (o = {}) => ({
  root: REPO, name: 'repo', kinds: ['git'], exists: true, isWorktree: false,
  artifacts: [], cacheMb: 0, outputMb: 0, nodeModulesMb: null, nxVersion: null,
  lastCommitDays: 0, procCount: 0, rssMb: 0, daemons: [], active: false, live: false, ...o,
});

const devServer = (o = {}) => ({
  pid: 4242, ppid: 1, rssMb: 250, cpu: 0, ageSec: 5 * 86400,
  cmd: 'node node_modules/.bin/vite', type: 'dev-server', project: REPO, ...o,
});

const art = (o = {}) => ({
  path: REPO + '/target', tool: 'cargo', category: 'output', sizeMb: 20000,
  lastWriteSec: 30 * 86400, ...o,
});

const kills = (plan, tier) =>
  plan.actions.filter((a) => a.kind === 'kill' && (tier == null || a.tier === tier));

test('a dev server abandoned for days is offered in tier 2', () => {
  const plan = buildPlan(scanWith({ projects: [proj()], processes: [devServer()] }), cfg);
  assert.equal(kills(plan, 2).length, 1, 'a 5-day-old dev server is abandoned, not in flight');
});

test('a dev server started minutes ago is never killed at any tier', () => {
  const plan = buildPlan(scanWith({
    projects: [proj({ active: true, procCount: 1 })],
    processes: [devServer({ ageSec: 600 })],
  }), cfg);
  assert.equal(kills(plan).length, 0, 'work in flight must stay untouched');
});

test('killing a dev server takes its child processes with it', () => {
  // pnpm/npm wrappers sit between the shell and the server; killing only the leaf orphans them.
  const plan = buildPlan(scanWith({
    projects: [proj()],
    processes: [devServer(), { ...devServer({ pid: 4243, ppid: 4242, rssMb: 10 }) }],
  }), cfg);
  const k = kills(plan, 2).find((a) => a.pid === 4242);
  assert.ok(k, 'the parent must be offered');
  assert.ok(k.cmd.includes('4243'), `child pid must be in the kill command: ${k.cmd.join(' ')}`);
  assert.equal(k.reclaimMb, 260, 'reclaim must count the children it also kills');
});

test('an abandoned process does not hold its project’s cold artifacts hostage', () => {
  // The bug this guards: one forgotten server kept a whole monorepo marked active, which
  // pinned every artifact in it to tier 3 for as long as the process stayed up.
  const plan = buildPlan(scanWith({
    projects: [proj({ artifacts: [art()], outputMb: 20000, procCount: 1 })],
    processes: [devServer()],
  }), cfg);
  const rm = plan.actions.filter((a) => a.kind === 'rm-artifact' && a.tier === 2);
  assert.equal(rm.length, 1, 'a 30-day-cold target/ must be reachable without --force');
});

// ── staleness is the artifact's own, not its repo's commit log ───────────────

test('a cold artifact in a repo committed to daily still reaches tier 2', () => {
  const plan = buildPlan(scanWith({
    projects: [proj({ lastCommitDays: 0, artifacts: [art()] })],
  }), cfg);
  assert.equal(plan.actions.filter((a) => a.kind === 'rm-artifact' && a.tier === 2).length, 1,
    'commit recency says nothing about whether a build directory is cold');
});

test('an artifact a build is currently writing to never reaches tier 2', () => {
  const plan = buildPlan(scanWith({
    projects: [proj({ artifacts: [art({ lastWriteSec: 30 })] })],
  }), cfg);
  assert.equal(plan.actions.filter((a) => a.kind === 'rm-artifact' && a.tier === 2).length, 0,
    'a fresh mtime is the signal that something is still using it');
});

test('an abandoned server is reaped even while its project is busy', () => {
  // A dev server nobody has touched in days is abandoned whether or not a test run happens
  // to be going in the same repo; otherwise a busy monorepo shelters it forever.
  const plan = buildPlan(scanWith({
    projects: [proj({ active: true, procCount: 2 })],
    processes: [devServer({ pid: 6001, ageSec: 4 * 86400 }),
                devServer({ pid: 6002, type: 'test-runner', ageSec: 60 })],
  }), cfg);
  assert.deepEqual(kills(plan, 2).map((a) => a.pid), [6001]);
});

test('an old helper inside a genuinely busy project is left alone', () => {
  // A long-lived esbuild/swc helper is serving the work that is running now; only its own
  // age is old. Reaping is for projects where nothing recent is running at all.
  const plan = buildPlan(scanWith({
    projects: [proj({ active: true, procCount: 2 })],
    processes: [
      devServer({ pid: 5001, type: 'esbuild', ageSec: 3 * 86400 }),
      devServer({ pid: 5002, type: 'nx-run', ageSec: 60 }),
    ],
  }), cfg);
  assert.equal(kills(plan).length, 0, 'work in flight protects its own helpers');
});

// ── a kill that did not kill is not "done" ───────────────────────────────────

test('classifiers catch the launchers and servers that fell through to bare node', () => {
  // nx moved its launcher under dist/ in some versions; only one path was matched.
  assert.equal(classify('node ./node_modules/.bin/../nx/bin/nx.js serve web'), 'nx-run');
  assert.equal(classify('node ./node_modules/.bin/../nx/dist/bin/nx.js serve api'), 'nx-run');
  // a compiled server is work, so it can be reaped once abandoned
  assert.equal(classify('node dist/apps/care-api/main.js'), 'node-server');
  assert.equal(classify('node build/server.js'), 'node-server');
  // but the same shape inside node_modules is somebody's tooling, not the user's server
  assert.notEqual(classify('node /x/node_modules/tool/dist/cli.js'), 'node-server');
});

test('an abandoned compiled server reaches tier 2', () => {
  const plan = buildPlan(scanWith({
    projects: [proj()],
    processes: [devServer({ type: 'node-server', cmd: 'node dist/apps/api/main.js' })],
  }), cfg);
  assert.equal(kills(plan, 2).length, 1);
});

test('applyPlan reports a kill as failed when the process survives', () => {
  // `kill` exits 0 on delivery, not on death. Use pid 1, which we may signal but never reap.
  const plan = { actions: [{ tier: 2, kind: 'kill', target: '/x', pid: 1, reclaimMb: 0,
                             reason: 'test', cmd: ['kill', '-TERM', '1'] }] };
  const [r] = applyPlan(plan, { maxTier: 2, dryRun: false });
  assert.notEqual(r.status, 'done', 'a surviving process must never be reported as done');
});
