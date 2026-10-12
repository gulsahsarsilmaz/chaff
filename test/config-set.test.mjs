/**
 * `config --set=roots=…` is the first command a new user is told to run, so it has to survive
 * their shell. zsh rejects an unquoted `["~/code"]` as a failed glob, and bash passes it on
 * with the quotes stripped, as `[~/code]` — which JSON.parse used to throw on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseListValue } from '../scripts/chaff.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');

const setConfig = (arg) => {
  const home = mkdtempSync(path.join(tmpdir(), 'chaff-set-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'config', arg], {
      encoding: 'utf8', timeout: 30_000, cwd: home, env: { ...process.env, CHAFF_HOME: home, CI: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
  } finally { rmSync(home, { recursive: true, force: true }); }
};

for (const [input, want] of [
  ['["~/code"]', ['~/code']],                 // quoted properly: JSON
  ['[~/code]', ['~/code']],                   // what bash leaves of an unquoted ["~/code"]
  ['~/code', ['~/code']],
  ['~/code,~/work', ['~/code', '~/work']],
  ['~/code, ~/work', ['~/code', '~/work']],
  ['[~/code,~/work]', ['~/code', '~/work']],
  ["['~/code']", ['~/code']],
  ['', []],
]) {
  test(`parseListValue(${JSON.stringify(input)})`, () => assert.deepEqual(parseListValue(input), want));
}

test('config --set=roots accepts the bash-mangled JSON form instead of crashing', () => {
  assert.deepEqual(setConfig('--set=roots=[~/code]').roots, ['~/code']);
});

test('config --set=roots accepts a plain comma list', () => {
  assert.deepEqual(setConfig('--set=roots=~/code,~/work').roots, ['~/code', '~/work']);
});

test('config --set=protect is parsed as a list too', () => {
  assert.deepEqual(setConfig('--set=protect=~/keep').protect, ['~/keep']);
});

test('non-list keys are unchanged', () => {
  assert.equal(setConfig('--set=policy=propose').policy, 'propose');
  assert.equal(setConfig('--set=thresholds.daemons=4').thresholds.daemons, 4);
});

test('no hint chaff prints tells the user to type brackets their shell will mangle', () => {
  const src = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(src, /chaff config --set=roots=\[/);
});
