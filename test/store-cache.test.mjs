/**
 * Sizing the shared package stores was most of a cold scan, so a store's size is reused for a
 * day. A day-old number may only ever narrow a cleanup: a prune offered on a reused size is
 * re-measured before it runs, and skipped if the store is no longer over the threshold.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let home, work, chaff;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'chaff-store-home-'));
  work = mkdtempSync(path.join(tmpdir(), 'chaff-store-work-'));
  process.env.CHAFF_HOME = home;          // read at module load, so set it first
  chaff = await import('../scripts/chaff.mjs?store-cache');
});
after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const MB = 1024 * 1024;
const store = (name, mb) => {
  const d = path.join(work, name);
  mkdirSync(path.join(d, 'deep', 'inside'), { recursive: true });
  writeFileSync(path.join(d, 'deep', 'inside', 'blob'), Buffer.alloc(mb * MB, 1));
  return d;
};
const grow = (d, mb) => writeFileSync(path.join(d, 'deep', 'inside', `more-${Date.now()}`), Buffer.alloc(mb * MB, 1));

test('a store is measured once and its size reused within the TTL', () => {
  const d = store('reuse', 2);
  const first = chaff.storeSizesMb([d]).get(d);
  assert.equal(first.reused, false);
  assert.ok(first.mb >= 2, `measured ${first.mb}MB`);
  grow(d, 3);                                  // a deep write: the root's mtime is no signal
  const second = chaff.storeSizesMb([d]).get(d);
  assert.equal(second.reused, true);
  assert.equal(second.mb, first.mb);
  assert.equal(second.at, first.at);
});

test('past the TTL the store is measured again', () => {
  const d = store('expire', 2);
  const first = chaff.storeSizesMb([d]).get(d);
  grow(d, 3);
  const later = chaff.storeSizesMb([d], { now: first.at + (chaff.STORE_SIZE_TTL_SEC + 1) * 1000 }).get(d);
  assert.equal(later.reused, false);
  assert.ok(later.mb >= first.mb + 3, `expected growth, got ${first.mb} -> ${later.mb}`);
});

test('refresh (--deep) measures again even within the TTL', () => {
  const d = store('refresh', 2);
  const first = chaff.storeSizesMb([d]).get(d);
  grow(d, 3);
  const again = chaff.storeSizesMb([d], { refresh: true }).get(d);
  assert.equal(again.reused, false);
  assert.ok(again.mb >= first.mb + 3);
});

test('a cached size from the future (clock skew) is not trusted', () => {
  const d = store('skew', 1);
  chaff.storeSizesMb([d], { now: Date.now() + 3600_000 });
  assert.equal(chaff.storeSizesMb([d]).get(d).reused, false);
});

// ── the plan ───────────────────────────────────────────────────────────────

const cfg = () => ({ ...chaff.DEFAULTS, protect: [], thresholds: { ...chaff.DEFAULTS.thresholds, storeGb: 1 } });
const scanWith = (stores) => ({
  schema: 2, scannedAt: new Date().toISOString(), roots: ['/repo'],
  disk: { totalGb: 100, usedGb: 50, freeGb: 50, pctUsed: 50 },
  totals: { nodeProcs: 0, nodeRssMb: 0, claudeProcs: 0, daemons: 0, projects: 0, worktrees: 0, cacheMb: 0, outputMb: 0, storeMb: 0 },
  projects: [], stores, worktrees: [], orphanArtifacts: [], processes: [],
});
const st = (o) => ({ name: 'npm cache', path: '/nowhere/_cacache', sizeMb: 5000, safe: true, prune: ['true'], ...o });
const prunes = (plan) => plan.actions.filter((a) => a.kind === 'prune-store');

test('a prune offered on a reused size carries a re-check; a fresh size does not', () => {
  assert.equal(prunes(chaff.buildPlan(scanWith([st({ reused: true })]), cfg()))[0].recheckMinMb, 1024);
  assert.equal(prunes(chaff.buildPlan(scanWith([st({ reused: false })]), cfg()))[0].recheckMinMb, undefined);
});

test('a reused size that is now stale skips the prune instead of running it', () => {
  const d = store('shrunk', 1);
  const marker = path.join(work, 'pruned-shrunk');
  const plan = chaff.buildPlan(scanWith([st({ path: d, reused: true, prune: ['touch', marker] })]), cfg());
  const [r] = chaff.applyPlan(plan, { maxTier: 2, dryRun: false });
  assert.equal(r.status, 'skipped');
  assert.match(r.note, /no longer over the store threshold/);
  assert.ok(!existsSync(marker), 'the prune command must not have run');
});

test('a reused size that still holds lets the prune run', () => {
  const d = store('still-big', 3);
  const marker = path.join(work, 'pruned-big');
  const plan = chaff.buildPlan(scanWith([st({ path: d, reused: true, prune: ['touch', marker] })]), cfg());
  plan.actions[0].recheckMinMb = 2;            // the 1GB threshold, scaled down for a test
  const [r] = chaff.applyPlan(plan, { maxTier: 2, dryRun: false });
  assert.equal(r.status, 'done');
  assert.ok(existsSync(marker));
});

test('a dry run never re-measures or acts', () => {
  const marker = path.join(work, 'pruned-dry');
  const plan = chaff.buildPlan(scanWith([st({ reused: true, prune: ['touch', marker] })]), cfg());
  const [r] = chaff.applyPlan(plan, { maxTier: 2, dryRun: true });
  assert.equal(r.status, 'dry-run');
  assert.ok(!existsSync(marker));
});

test('tier 1 never includes a store action, reused size or not', () => {
  const plan = chaff.buildPlan(scanWith([st({ reused: true }), st({ name: 'playwright browsers', safe: false, prune: null, reused: true })]), cfg());
  for (const a of plan.actions.filter((x) => /store/.test(x.kind))) assert.ok(a.tier >= 2, `${a.kind} at tier ${a.tier}`);
});
