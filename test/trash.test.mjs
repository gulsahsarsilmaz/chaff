/** Undo is only worth shipping if restore genuinely returns the bytes, intact. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let home, work, chaff;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'chaff-trash-home-'));
  work = mkdtempSync(path.join(tmpdir(), 'chaff-trash-work-'));
  process.env.CHAFF_HOME = home;          // read at module load, so set it first
  chaff = await import('../scripts/chaff.mjs?trash');
});
after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const victim = (name, body = 'precious\n') => {
  const d = path.join(work, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'bundle.js'), body);
  return d;
};

test('trashing moves the directory rather than destroying it', () => {
  const d = victim('dist-move');
  const dest = chaff.trashPath(d);
  assert.ok(dest, 'should return a trash path');
  assert.ok(!existsSync(d), 'original is gone from its place');
  assert.ok(existsSync(dest), 'but still exists in the trash');
  assert.equal(readFileSync(path.join(dest, 'bundle.js'), 'utf8'), 'precious\n', 'contents survive');
});

test('restore returns the directory to its exact original path, byte for byte', () => {
  const d = victim('dist-restore', 'irreplaceable\n');
  chaff.trashPath(d);
  assert.ok(!existsSync(d));
  const entry = chaff.trashList().find((e) => e.origin === d);
  assert.ok(entry, 'the entry records where it came from');
  const r = chaff.trashRestore(entry.id);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.origin, d, 'restored to the original path');
  assert.equal(readFileSync(path.join(d, 'bundle.js'), 'utf8'), 'irreplaceable\n');
});

test('restore refuses to clobber something that now occupies the original path', () => {
  const d = victim('dist-clash');
  chaff.trashPath(d);
  const entry = chaff.trashList().find((e) => e.origin === d);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'new.js'), 'newer\n');
  const r = chaff.trashRestore(entry.id);
  assert.equal(r.ok, false, 'must not overwrite newer content');
  assert.match(r.why, /already exists/);
  assert.equal(readFileSync(path.join(d, 'new.js'), 'utf8'), 'newer\n', 'the newer content is untouched');
});

test('purge respects the TTL and only removes what is older', () => {
  chaff.trashPath(victim('dist-fresh'));
  assert.equal(chaff.trashPurge(7), 0, 'a fresh entry must survive a 7-day TTL');
  assert.ok(chaff.trashList().length > 0);
  chaff.trashPurge(0);
  assert.equal(chaff.trashList().length, 0, 'a zero TTL clears everything');
});

test('a stale artifact survives the purge that runs right after it is trashed', () => {
  // Tier 2 only trashes things untouched for staleArtifactDays, and a rename keeps the
  // directory's mtime. Ageing entries by that mtime purged them in the same run.
  const d = victim('dist-cold');
  const month = new Date(Date.now() - 30 * 86400_000);
  utimesSync(d, month, month);
  chaff.trashPath(d);
  assert.equal(chaff.trashPurge(7), 0, 'a just-trashed entry must survive a 7-day TTL');
  const entry = chaff.trashList().find((e) => e.origin === d);
  assert.ok(entry, 'still restorable');
  assert.ok(entry.ageSec < 60, `age is time in the trash, got ${entry.ageSec}s`);
  chaff.trashPurge(0);
});

test('an unknown id is reported, not silently ignored', () => {
  assert.equal(chaff.trashRestore('nope').ok, false);
});
