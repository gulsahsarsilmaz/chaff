/**
 * Scope has to be honest: an inferred root set that nobody announces lets a user read
 * "all clear" about a machine chaff never looked at, and an inferred root at or above
 * $HOME turns a scan into a multi-minute crawl of Library and Downloads.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { DEFAULTS, resolveRoots, renderStatusline, renderExplain, renderTiles, classify } from '../scripts/chaff.mjs';

let base, repo, cwd0;

before(() => {
  cwd0 = process.cwd();
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'chaff-roots-')));
  repo = path.join(base, 'proj');
  mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}');
});

after(() => { process.chdir(cwd0); rmSync(base, { recursive: true, force: true }); });

test('configured roots are used as-is and never reported as inferred', () => {
  const r = resolveRoots({ ...DEFAULTS, roots: [base] });
  assert.deepEqual(r.roots, [base]);
  assert.equal(r.inferred, false);
  assert.equal(r.refused, null);
});

test('with no config, roots are inferred from the repo and its parent, and marked inferred', () => {
  process.chdir(repo);
  const r = resolveRoots({ ...DEFAULTS, roots: [] });
  assert.equal(r.inferred, true);
  assert.equal(r.refused, null);
  assert.ok(r.roots.includes(repo), `expected ${repo} in ${r.roots}`);
  assert.ok(r.roots.includes(base), `expected ${base} in ${r.roots}`);
});

test('inference never returns $HOME or an ancestor of it — no home-directory crawl', () => {
  process.chdir(homedir());
  const r = resolveRoots({ ...DEFAULTS, roots: [] });
  assert.deepEqual(r.roots, []);
  assert.equal(r.refused, homedir());
  assert.equal(r.inferred, true);
});

// nodeRssMb now defaults to a share of physical RAM, so a fixture that relied on the
// default would breach or not depending on whose machine ran the suite. Pin it.
const CFG = { ...DEFAULTS, thresholds: { ...DEFAULTS.thresholds, nodeRssMb: 4096 } };

// A scan record with one breach (node memory) and everything else under its threshold.
const scan = {
  roots: ['/x'], rootsInferred: false, rootsRefused: null,
  totals: { nodeRssMb: 9999, nodeProcs: 3, daemons: 1, cacheMb: 10, outputMb: 10, worktrees: 2 },
  disk: { freeGb: 500, totalGb: 900 },
};

test('statusline colors the breached metric red and the healthy ones green', () => {
  const out = renderStatusline(scan, CFG);
  assert.match(out, /\x1b\[31m9\.8G\/3p/);
  assert.match(out, /\x1b\[32m1d/);
  assert.ok(!out.includes('🔴'), 'color style must not also emit emoji');
});

test('dots style keeps the emoji and emits no ANSI', () => {
  const out = renderStatusline(scan, { ...CFG, statuslineStyle: 'dots' });
  assert.ok(out.includes('🔴 9.8G/3p'));
  assert.ok(!out.includes('\x1b['), 'dots style must not emit ANSI');
});

test('plain style marks nothing', () => {
  const out = renderStatusline(scan, { ...CFG, statuslineStyle: 'plain' });
  assert.ok(!out.includes('\x1b['));
  assert.ok(!out.includes('🔴') && !out.includes('🟢'));
});

test('NO_COLOR downgrades the color style to plain', () => {
  process.env.NO_COLOR = '1';
  try {
    const out = renderStatusline(scan, CFG);
    assert.ok(!out.includes('\x1b['));
  } finally { delete process.env.NO_COLOR; }
});

test('an inferred scope is flagged on the statusline itself', () => {
  const inferred = renderStatusline({ ...scan, rootsInferred: true }, { ...CFG, statuslineStyle: 'plain' });
  assert.match(inferred, /⚠ cwd/);
  const refused = renderStatusline({ ...scan, rootsInferred: true, rootsRefused: '/Users/x' }, { ...CFG, statuslineStyle: 'plain' });
  assert.match(refused, /⚠ no roots/);
});


test('a metric with nothing to report is dropped, not shown as a green zero', () => {
  const quiet = { ...scan, totals: { ...scan.totals, daemons: 0, worktrees: 0 } };
  const out = renderStatusline(quiet, { ...CFG, statuslineStyle: 'plain' });
  assert.ok(!/\b0d\b/.test(out), `daemons segment should be absent: ${out}`);
  assert.ok(!/\b0wt\b/.test(out), `worktree segment should be absent: ${out}`);
  // The readings that are always meaningful stay put.
  assert.match(out, /9\.8G\/3p/);
  assert.match(out, /500G free/);
  assert.match(out, /G junk/);
});

test('a zero disk or memory reading still renders — zero there is a fact, not an absence', () => {
  const idle = { ...scan, totals: { ...scan.totals, nodeRssMb: 0, nodeProcs: 0, cacheMb: 0, outputMb: 0 } };
  const out = renderStatusline(idle, { ...CFG, statuslineStyle: 'plain' });
  assert.match(out, /0\.0G\/0p/);
  assert.match(out, /0\.0G junk/);
});

test('language servers are daemons, so a no-daemon toolchain still reports the one it has', () => {
  assert.equal(classify('/Users/x/.cargo/bin/rust-analyzer'), 'rust-analyzer');
  assert.equal(classify('/opt/homebrew/bin/gopls serve'), 'gopls');
  assert.equal(classify('/usr/local/share/omnisharp/OmniSharp --languageserver'), 'omnisharp');
  // and the one-shot compilers they used to be lumped in with are still work
  assert.equal(classify('cargo build --release'), 'rust');
  assert.equal(classify('go build ./...'), 'go');
});

test('the legend explains every metric the statusline abbreviates', () => {
  const out = renderExplain(scan, { ...CFG, statuslineStyle: 'plain' }, 120);
  for (const label of ['TOOLCHAIN MEM', 'DAEMONS', 'DISK FREE', 'JUNK', 'WORKTREES']) {
    assert.ok(out.includes(label), `${label} missing from the legend`);
  }
  // the two abbreviations nobody guesses right, spelled out
  assert.match(out, /git worktrees/);
  assert.match(out, /long-lived servers/);
  // threshold and current reading sit next to each other
  assert.match(out, /> 4\.0G/);
  assert.match(out, /over/);
});

test('the legend stays inside a narrow terminal instead of wrapping a five-column table', () => {
  const narrow = renderExplain(scan, { ...CFG, statuslineStyle: 'plain' }, 80);
  for (const line of narrow.split('\n')) assert.ok(line.length <= 80, `line too wide: ${line}`);
  assert.ok(!narrow.includes('WHAT IT MEANS'), 'narrow layout must not use the table header');
});

test('tiles only claim the width they were given', () => {
  const lines = renderTiles(scan, { ...CFG, statuslineStyle: 'plain' }, 120);
  for (const line of lines) assert.ok(line.length <= 120, `tile line too wide: ${line}`);
  assert.ok(lines.join('\n').includes('WORKTREES'));
});
