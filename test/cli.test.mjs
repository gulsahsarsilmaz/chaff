/**
 * Argument handling on the destructive verbs. `+'all'` is NaN, every `tier >= 2` guard is
 * false for NaN, and `a.tier > NaN` admits every action — so a typo once skipped --yes and
 * --force and ran tier 3. These must refuse before anything is scanned or touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');

const chaff = (...args) => {
  const home = mkdtempSync(path.join(tmpdir(), 'chaff-cli-'));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', timeout: 30_000, cwd: home, env: { ...process.env, CHAFF_HOME: home, CI: '' },
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
};

for (const args of [
  ['clean', '--tier=all'],
  ['clean', '--tier=3x'],
  ['apply', '--tier=', '--yes'],
  ['ci', '--tier=two'],
  ['schedule', '--install', '--tier=x'],
]) {
  test(`${args.join(' ')} is refused with exit 2`, () => {
    const r = chaff(...args);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /--tier must be 1, 2 or 3/);
  });
}

test('runs when launched through a symlink, the way npm installs the bin', { skip: process.platform === 'win32' }, () => {
  // npm links <prefix>/bin/chaff -> …/scripts/chaff.mjs, for global installs and npx alike.
  // argv[1] is the link, import.meta.url the target: compared raw, chaff silently did nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'chaff-bin-'));
  try {
    const link = path.join(dir, 'chaff');
    symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link, 'help'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, CHAFF_HOME: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /chaff/i, 'help must actually print');
    assert.ok(r.stdout.length > 200, `expected the help text, got: ${JSON.stringify(r.stdout)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
