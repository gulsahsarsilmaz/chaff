/**
 * Reading a hand-edited config.json — the likeliest malformed input chaff sees. Whatever is in
 * the file, chaff must start, keep what it can, and say what it ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');

const load = (raw) => {
  const home = mkdtempSync(path.join(tmpdir(), 'chaff-cfg-'));
  try {
    if (raw !== undefined) writeFileSync(path.join(home, 'config.json'), raw);
    const r = spawnSync(process.execPath, [CLI, 'config'], {
      encoding: 'utf8', timeout: 30_000, cwd: home, env: { ...process.env, CHAFF_HOME: home, CI: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    return { cfg: JSON.parse(r.stdout), stderr: r.stderr };
  } finally { rmSync(home, { recursive: true, force: true }); }
};

test('no config file: the defaults, silently', () => {
  const { cfg, stderr } = load(undefined);
  assert.deepEqual(cfg.roots, []);
  assert.equal(cfg.policy, 'propose');
  assert.equal(stderr, '');
});

test('invalid JSON: defaults, with a warning naming the file', () => {
  const { cfg, stderr } = load('{ roots: [');
  assert.equal(cfg.policy, 'propose');
  assert.match(stderr, /config\.json is not valid JSON/);
});

test('a JSON array or string instead of an object is treated as empty', () => {
  assert.equal(load('[1,2]').cfg.policy, 'propose');
  assert.equal(load('"hello"').cfg.policy, 'propose');
});

test('a lone string where a list belongs becomes a one-item list', () => {
  const { cfg } = load(JSON.stringify({ roots: '~/code', protect: '~/keep' }));
  assert.deepEqual(cfg.roots, ['~/code']);
  assert.deepEqual(cfg.protect, ['~/keep']);
});

test('non-path entries in a list are dropped with a warning', () => {
  const { cfg, stderr } = load(JSON.stringify({ roots: ['~/code', 7, '', null] }));
  assert.deepEqual(cfg.roots, ['~/code']);
  assert.match(stderr, /may only hold non-empty paths/);
});

test('a list key of the wrong type falls back to the default', () => {
  const { cfg, stderr } = load(JSON.stringify({ roots: { a: 1 } }));
  assert.deepEqual(cfg.roots, []);
  assert.match(stderr, /must be a list of paths/);
});

test('the old staleProjectDays key still works', () => {
  assert.equal(load(JSON.stringify({ staleProjectDays: 12 })).cfg.staleArtifactDays, 12);
  assert.equal(load(JSON.stringify({ staleProjectDays: 12, staleArtifactDays: 3 })).cfg.staleArtifactDays, 3, 'the new key wins');
});

test('partial thresholds are merged over the defaults, not replacing them', () => {
  const { cfg } = load(JSON.stringify({ thresholds: { daemons: 9 } }));
  assert.equal(cfg.thresholds.daemons, 9);
  assert.equal(cfg.thresholds.diskFreeGb, 60);
  assert.ok(cfg.thresholds.nodeRssMb >= 4096);
});
