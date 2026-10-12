/**
 * One definition of "over the limit". The plan, the tiles, the statusline and the session
 * hook used to answer separately and disagree; these pin that they now share an answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { breaches, defaultThresholds, junkMb } from '../scripts/thresholds.mjs';
import { DEFAULTS, buildPlan, renderStatusline } from '../scripts/chaff.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hook-session-start.mjs');
const t = { nodeRssMb: 4096, daemons: 4, diskFreeGb: 60, cacheGb: 3, worktrees: 25, storeGb: 10 };
const scanWith = (totals = {}, disk = {}) => ({
  schema: 2, scannedAt: new Date().toISOString(), roots: ['/r'],
  disk: { totalGb: 500, usedGb: 100, freeGb: 400, pctUsed: 20, ...disk },
  totals: { nodeProcs: 1, nodeRssMb: 100, claudeProcs: 0, daemons: 0, projects: 0, worktrees: 0,
            cacheMb: 0, outputMb: 0, storeMb: 0, ...totals },
  projects: [], stores: [], worktrees: [], orphanArtifacts: [], processes: [],
});
const keys = (s) => breaches(s, t).map((b) => b.key);

test('nothing breached on a quiet machine', () => assert.deepEqual(keys(scanWith()), []));

test('each limit is reported under its own key', () => {
  assert.deepEqual(keys(scanWith({ nodeRssMb: 5000 })), ['memory']);
  assert.deepEqual(keys(scanWith({ daemons: 5 })), ['daemons']);
  assert.deepEqual(keys(scanWith({}, { freeGb: 10 })), ['disk']);
  assert.deepEqual(keys(scanWith({ worktrees: 26 })), ['worktrees']);
  assert.deepEqual(keys(scanWith({ storeMb: 11 * 1024 })), ['stores']);
});

test('junk is build cache plus build output, everywhere', () => {
  const s = scanWith({ cacheMb: 1024, outputMb: 2.5 * 1024 });   // 1GB cache alone is under 3GB
  assert.equal(junkMb(s), 3.5 * 1024);
  assert.deepEqual(keys(s), ['junk']);
  const cfg = { ...DEFAULTS, thresholds: t, protect: [] };
  assert.ok(buildPlan(s, cfg).breached.some((x) => /build cache and output/.test(x)), 'the plan agrees');
  assert.match(renderStatusline(s, { ...cfg, statuslineStyle: 'dots' }), /🔴 3\.5G junk/, 'the statusline agrees');
});

test('the default memory limit scales with RAM (floor 4GB)', () => {
  assert.equal(defaultThresholds().nodeRssMb, Math.max(4096, Math.round((totalmem() / 1048576) * 0.35)));
  assert.deepEqual(DEFAULTS.thresholds, defaultThresholds());
});

test('the session hook warns on exactly what breaches() reports, with the real defaults', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'chaff-thr-'));
  try {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoStatusline: false, updateCheck: false, roots: [home] }));
    // Just above 4GB: the old hook's hard-coded limit warned here on any machine with more
    // than ~12GB of RAM, while the statusline (RAM-scaled) stayed green.
    const s = scanWith({ nodeRssMb: 4200 });
    s.config = { thresholds: defaultThresholds() };
    writeFileSync(path.join(home, 'scan-cache.json'), JSON.stringify(s));
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', input: '{}', env: { ...process.env, CHAFF_HOME: home, CI: '' } });
    assert.equal(r.status, 0, r.stderr);
    const expected = breaches(s, defaultThresholds()).some((b) => b.key === 'memory');
    assert.equal(/toolchain memory/.test(r.stdout), expected,
      `hook and breaches() must agree at the RAM-scaled limit (${defaultThresholds().nodeRssMb}MB)`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
