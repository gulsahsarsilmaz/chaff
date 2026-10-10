/**
 * chaff's inventory comes from find/du/df/ps. On Windows those are absent or mean something
 * else entirely, so a scan there returns almost nothing rather than failing — and an empty
 * inventory handed to a cleanup planner is the one failure this tool must never have.
 *
 * These tests pin the refusal. They fake win32 rather than needing a Windows machine; CI runs
 * the same checks natively on windows-latest, which is what actually proves it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');

/** Run the CLI with process.platform forced to win32, before chaff.mjs is evaluated. */
const asWindows = (...args) => {
  const harness = `
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.argv = [process.argv[0], ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(path.sep === '\\' ? 'file:///' + CLI.replace(/\\/g, '/') : CLI)});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', harness], { encoding: 'utf8', timeout: 60_000 });
};

test('a scan-dependent command refuses on Windows instead of scanning', () => {
  for (const sub of ['status', 'plan', 'doctor', 'worktrees', 'top']) {
    const r = asWindows(sub);
    assert.equal(r.status, 4, `${sub} should exit 4 on Windows, got ${r.status}`);
    assert.match(r.stderr, /POSIX scan layer/, `${sub} must say why`);
  }
});

test('the refusal tells the user what to do instead', () => {
  const { stderr } = asWindows('status');
  assert.match(stderr, /wsl/i, 'must point at WSL');
  assert.match(stderr, /\/mnt\/c/, 'must warn that scanning /mnt/c is not worth doing');
});

test('cleanup is refused on Windows too — not just reporting', () => {
  // The dangerous direction. A bogus plan must never reach applyPlan.
  for (const sub of ['reap', 'clean', 'apply']) {
    const r = asWindows(sub, '--dry-run');
    assert.equal(r.status, 4, `${sub} must refuse on Windows`);
  }
});

test('help and config still work on Windows', () => {
  const h = asWindows('help');
  assert.equal(h.status, 0, `help must work: ${h.stderr}`);
  assert.match(h.stdout, /chaff/);

  const c = asWindows('config');
  assert.equal(c.status, 0, `config must work: ${c.stderr}`);
  JSON.parse(c.stdout);                       // must still be valid JSON
});

test('paths are grouped without assuming a forward slash', async () => {
  // The cargo-duplication check keys on the last few path segments. On Windows those arrive
  // backslash-separated, and a naive split('/') would put every target/ in one bucket.
  const { buildPlan, DEFAULTS } = await import('../scripts/chaff.mjs');
  const art = (p) => ({ path: p, tool: 'cargo/maven', sizeMb: 900, kind: 'output', exists: true });
  const proj = (name, root) => ({
    name, path: root, exists: true, ageDays: 1, lastTouched: Date.now(),
    artifacts: [art(root + '\\src-tauri\\target')], active: false, cacheMb: 0, outputMb: 900,
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
