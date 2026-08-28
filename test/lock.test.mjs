/** The lock is what stopped chaff from taking a machine down by stacking scans. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir, chaff;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'chaff-lock-'));
  process.env.CHAFF_HOME = dir;
  chaff = await import('../scripts/chaff.mjs?lock');
});
after(() => rmSync(dir, { recursive: true, force: true }));

const LOCK = () => path.join(process.env.CHAFF_HOME, 'scan.lock');

test('the lock can only be held once at a time', () => {
  const a = chaff.acquireLock();
  assert.ok(a, 'first caller takes it');
  assert.equal(chaff.acquireLock(), null, 'second caller is refused');
  chaff.releaseLock(a);
  const b = chaff.acquireLock();
  assert.ok(b, 'available again after release');
  chaff.releaseLock(b);
});

test('releasing removes the lock file', () => {
  const l = chaff.acquireLock();
  assert.ok(existsSync(LOCK()));
  chaff.releaseLock(l);
  assert.ok(!existsSync(LOCK()), 'a released lock must not linger and block future scans');
});

test('a lock held by a dead process is taken over', () => {
  // PID 2^22 is above any real pid; stands in for a crashed scan.
  writeFileSync(LOCK(), JSON.stringify({ pid: 4194304, at: Date.now() }));
  const l = chaff.acquireLock();
  assert.ok(l, 'a crashed scan must not wedge chaff forever');
  chaff.releaseLock(l);
});

test('an ancient lock is taken over even if the pid is alive', () => {
  writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, at: Date.now() - 3600_000 }));
  const l = chaff.acquireLock({ maxAgeSec: 600 });
  assert.ok(l, 'a wedged scan older than the ceiling must not block forever');
  chaff.releaseLock(l);
});

test('a fresh lock held by a live process is respected', () => {
  writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(chaff.acquireLock(), null);
  assert.equal(chaff.scanInProgress(), true);
});

test('releasing someone else\'s lock is a no-op', () => {
  writeFileSync(LOCK(), JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
  chaff.releaseLock(LOCK());
  assert.ok(existsSync(LOCK()), 'must not delete a lock this process does not own');
});
