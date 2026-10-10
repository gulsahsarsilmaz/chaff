/**
 * Argument handling on the destructive verbs. `+'all'` is NaN, every `tier >= 2` guard is
 * false for NaN, and `a.tier > NaN` admits every action — so a typo once skipped --yes and
 * --force and ran tier 3. These must refuse before anything is scanned or touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
