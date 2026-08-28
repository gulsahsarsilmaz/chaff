/**
 * The invariants that matter. chaff's main verb is `rm -rf`, so these guard the cases where
 * a regression would destroy someone's work rather than merely inconvenience them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, applyPlan, DEFAULTS } from '../scripts/chaff.mjs';

const cfg = { ...DEFAULTS, staleWorktreeDays: 7, staleProjectDays: 7, protect: [] };

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
                  cmd: 'node x', type: 'nx-daemon', project: '/definitely/not/here' }],
    worktrees: [wt({ prunable: true, exists: false })],
  });
  const plan = buildPlan(scan, cfg);
  const t1 = plan.actions.filter((a) => a.tier === 1);
  assert.ok(t1.length >= 2, 'dead process and prunable worktree both belong in tier 1');
  for (const a of t1) assert.ok(['kill', 'prune-worktree', 'rm-artifact'].includes(a.kind));
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
