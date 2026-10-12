/**
 * The trash is the undo button, so it must hold on every filesystem layout. A move across
 * filesystems (EXDEV) used to fall back to a permanent delete and report "done"; it now
 * copies, verifies, and only then removes the original, or leaves the original alone. Trash
 * entry names must be legal everywhere, and restore must use the exact recorded path.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, renameSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let home, work, chaff, trashDir;

before(async () => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'chaff-exdev-home-')));
  work = realpathSync(mkdtempSync(path.join(tmpdir(), 'chaff-exdev-work-')));
  process.env.CHAFF_HOME = home;              // read at module load
  chaff = await import('../scripts/chaff.mjs?trash-exdev');
  trashDir = path.join(home, 'trash');
});
after(() => {
  chaff.__setRenameForTests(null);
  rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
});

/** Every rename into (or out of) the trash fails as if it crossed a filesystem. */
const crossDevice = (from, to) => {
  if (to.startsWith(trashDir) || from.startsWith(trashDir)) {
    const e = new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`); e.code = 'EXDEV'; throw e;
  }
  return renameSync(from, to);
};

const hashTree = (dir) => {
  const h = createHash('sha256');
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const full = path.join(d, n), r = `${rel}/${n}`;
      if (statSync(full).isDirectory()) { h.update(`d:${r}`); walk(full, r); } else { h.update(`f:${r}`); h.update(readFileSync(full)); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
};

const artifact = (name) => {
  const d = path.join(work, name, 'target');
  mkdirSync(path.join(d, 'release', 'deps'), { recursive: true });
  writeFileSync(path.join(d, 'release', 'app.bin'), Buffer.alloc(256 * 1024, 9));
  writeFileSync(path.join(d, 'release', 'deps', 'x.rlib'), 'rlib');
  return d;
};
const rmAction = (target) => ({ tier: 2, kind: 'rm-artifact', target, reclaimMb: 1, cmd: ['rm', '-rf', target] });

test('trash entry names are legal on every filesystem', () => {
  for (const p of ['C:\\Users\\Jo Smith\\app\\target', '/home/jo/app/target', 'D:/repos/a:b/dist', '\\\\server\\share\\x']) {
    const slug = chaff.trashSlug(p);
    assert.doesNotMatch(slug, /[<>:"|?*\\/\x00-\x1f]/, `${p} -> ${slug}`);
    assert.ok(slug.length > 0);
  }
  assert.equal(chaff.trashSlug('C:\\Users\\jo\\app\\target'), 'C___Users__jo__app__target');
  assert.equal(chaff.trashSlug('/home/jo/app/target'), 'home__jo__app__target');
});

test('across filesystems, a trashed directory is copied, verified, and the original removed', () => {
  const target = artifact('cross');
  const before = hashTree(target);
  chaff.__setRenameForTests(crossDevice);
  try {
    const [r] = chaff.applyPlan({ actions: [rmAction(target)] }, { maxTier: 2, dryRun: false, useTrash: true });
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.equal(r.note, 'trashed');
    assert.ok(!existsSync(target), 'the original is gone only after the copy verified');
    assert.equal(hashTree(r.trash), before, 'the trash holds an exact copy');
    assert.equal(readFileSync(r.trash + '.origin', 'utf8'), target, 'the exact original path is recorded');

    const restored = chaff.trashRestore(path.basename(r.trash));
    assert.equal(restored.ok, true, restored.why);
    assert.equal(restored.origin, target);
    assert.equal(hashTree(target), before, 'restored byte for byte, across filesystems too');
  } finally { chaff.__setRenameForTests(null); }
});

test('if the copy cannot be made, nothing is deleted and the action says so', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions, not root' }, () => {
  const target = artifact('unreadable');
  const secret = path.join(target, 'release', 'deps', 'x.rlib');
  chmodSync(secret, 0o000);                     // cpSync cannot read it
  chaff.__setRenameForTests(crossDevice);
  try {
    const [r] = chaff.applyPlan({ actions: [rmAction(target)] }, { maxTier: 2, dryRun: false, useTrash: true });
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.match(r.note, /nothing was deleted/);
    assert.ok(existsSync(path.join(target, 'release', 'app.bin')), 'the original is untouched');
    assert.ok(existsSync(secret));
    assert.deepEqual(readdirSync(trashDir).filter((f) => f.includes('unreadable')), [], 'no partial copy is left in the trash');
  } finally {
    chaff.__setRenameForTests(null);
    chmodSync(secret, 0o644);
  }
});

test('with the trash on, no failure ever falls through to a permanent delete', () => {
  const target = artifact('boom');
  chaff.__setRenameForTests(() => { const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; });
  try {
    const [r] = chaff.applyPlan({ actions: [rmAction(target)] }, { maxTier: 2, dryRun: false, useTrash: true });
    assert.equal(r.status, 'failed');
    assert.ok(existsSync(target), 'an unexpected rename error must not become rm -rf');
  } finally { chaff.__setRenameForTests(null); }
});
