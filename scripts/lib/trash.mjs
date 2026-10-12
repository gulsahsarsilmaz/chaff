/**
 * chaff's undo. Removal is a move into ~/.chaff/trash with a TTL, never an rm: across volumes
 * it copies, verifies and only then removes the original, and anything it cannot move safely
 * is left in place.
 */
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IS_WIN, paths } from './paths.mjs';

//
// chaff's main verb is `rm -rf`. Everything it removes is regenerable in principle, but
// "in principle" is cold comfort the first time you run it on your own machine. Moving
// instead of unlinking costs one rename and makes the whole thing reversible.

/**
 * Windows refuses to rename a directory while anything inside it is held open — a running
 * dev server, an editor, an antivirus scan. That is the one situation where "move it away"
 * must not quietly become "delete it", so it gets its own error and the action is skipped.
 */
export const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
export class LockedError extends Error {
  constructor(p, code) { super(`in use (${code}), left in place: ${p}`); this.code = 'LOCKED'; }
}

/**
 * The trash entry's file name, from the original path. Only a label: restore reads the exact
 * original path from the `.origin` sidecar, never from this. It must be a legal name on
 * every filesystem chaff runs on, so the drive colon of `C:\x` and anything else NTFS
 * rejects (`<>:"|?*`, control characters) becomes `_`, and separators become `__`.
 */
export function trashSlug(target) {
  return target.replace(/^[\/\\]+/, '').replace(/[\/\\]+/g, '__').replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

// The one rename the trash depends on, replaceable in tests to simulate a cross-volume move.
export let renameImpl = renameSync;
export function __setRenameForTests(fn) { renameImpl = fn || renameSync; }

/** Move `target` into the trash. Returns the trash path. Never deletes without a verified copy. */
export function trashPath(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(paths.trash, `${stamp}__${trashSlug(target)}`);
  mkdirSync(paths.trash, { recursive: true });
  try {
    renameImpl(target, dest);
    writeFileSync(dest + '.origin', target);
    return dest;
  } catch (e) {
    // A rename cannot cross filesystems — repos on D: with the trash on C:, or a repo on an
    // external disk. A permanent delete there would quietly break the undo promise, so copy,
    // verify, and only then remove the original; if that cannot be done, nothing is removed.
    if (e.code === 'EXDEV') return moveByCopy(target, dest, { origin: target });
    if (IS_WIN && LOCKED_CODES.has(e.code)) throw new LockedError(target, e.code);
    throw e;
  }
}

/**
 * A cross-volume move that never loses data: probe for locks with a rename in place (atomic,
 * and it fails if anything inside is held open), copy, check the copy entry by entry, and
 * only then remove the source. Any failure before that last step leaves the source exactly
 * as it was and removes the partial copy.
 */
export function moveByCopy(src, dest, { origin } = {}) {
  const probe = `${src}.chaff-probe-${process.pid}`;
  try { renameSync(src, probe); }
  catch (e) { throw LOCKED_CODES.has(e.code) ? new LockedError(src, e.code) : e; }
  try { renameSync(probe, src); }
  catch (e) { throw new Error(`could not rename ${probe} back to ${src} (${e.code}); move it back by hand`); }
  // Copy into a staging dir that only this call ever created, then rename it into place. On
  // failure the only thing removed is that staging copy: never `dest`, which for a restore is
  // the user's own path, and could have appeared since the caller checked it was free.
  const staging = `${dest}.chaff-partial-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(src, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true });
    const diff = treeDiff(src, staging);
    if (diff) throw new Error(`copy did not verify: ${diff}`);
    if (existsSync(dest)) throw new Error(`${dest} appeared while copying; left it alone`);
    renameSync(staging, dest);
    if (origin) writeFileSync(dest + '.origin', origin);
  } catch (e) {
    try { if (existsSync(staging)) removeTree(staging); } catch { /* best effort: the source is untouched either way */ }
    throw e;
  }
  try { removeTree(src); }
  catch (e) {
    const err = new Error(`copied and verified to ${dest}, but ${src} was only partly removed (${e.code || e.message})`);
    err.code = 'PARTIAL';
    throw err;
  }
  return dest;
}

/** The first difference between two trees (relative path, type, file size), or null. */
export function treeDiff(a, b) {
  const list = (root) => {
    const out = new Map();
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
        const st = lstatSync(full);
        const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
        out.set(r, type === 'file' ? `file:${st.size}` : type);
        if (type === 'dir') walk(full, r);
      }
    };
    walk(root, '');
    return out;
  };
  const x = list(a), y = list(b);
  for (const [k, v] of x) if (y.get(k) !== v) return `${k}: ${v} vs ${y.get(k) ?? 'missing'}`;
  for (const k of y.keys()) if (!x.has(k)) return `${k}: unexpected in copy`;
  return null;
}

/**
 * Remove a tree without ever following a link. A junction or symlink inside it is removed as
 * a link; what it points at is not touched. Read-only files (common under .git and in npm
 * caches on Windows) are made writable first, since Windows will not unlink them otherwise.
 */
export function removeTree(p) {
  let st;
  try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (st.isSymbolicLink()) {
    try { unlinkSync(p); } catch (e) { if (e.code === 'EPERM' || e.code === 'EISDIR') fs.rmdirSync(p); else throw e; }
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
    return;
  }
  try { unlinkSync(p); }
  catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    fs.chmodSync(p, 0o666);
    unlinkSync(p);
  }
}

/** Entries currently in the trash, newest first. */
export function trashList() {
  if (!existsSync(paths.trash)) return [];
  return readdirSync(paths.trash)
    .filter((f) => !f.endsWith('.origin'))
    .map((f) => {
      const full = path.join(paths.trash, f);
      let origin = '?';
      try { origin = readFileSync(full + '.origin', 'utf8'); } catch { /* older entry */ }
      // Age is time in the trash, read from the .origin sidecar written at trash time. The
      // entry's own mtime is the artifact's: a rename preserves it, and tier 2 only trashes
      // things untouched for staleArtifactDays — so measuring that purged them in the same
      // run that trashed them. The entry's mtime is only a fallback for sidecar-less entries.
      // Clamp: a just-created entry can carry an mtime a hair ahead of Date.now() thanks to
      // filesystem timestamp resolution, and a negative age would slip past every TTL test.
      let ageSec = 0;
      let trashedMs = null;
      try { trashedMs = statSync(full + '.origin').mtimeMs; } catch { /* older entry */ }
      try { ageSec = Math.max(0, (Date.now() - (trashedMs ?? statSync(full).mtimeMs)) / 1000); } catch { /* raced */ }
      return { id: f, path: full, origin, ageSec };
    })
    .sort((a, b) => a.ageSec - b.ageSec);
}

/** Delete trashed entries older than the TTL. */
export function trashPurge(ttlDays) {
  let n = 0;
  for (const e of trashList()) {
    if (e.ageSec / 86400 < ttlDays) continue;
    try {
      if (IS_WIN) removeTree(e.path); else rmSync(e.path, { recursive: true, force: true });
      rmSync(e.path + '.origin', { force: true }); n++;
    }
    catch { /* best effort */ }
  }
  return n;
}

export function trashRestore(id) {
  // An exact id, or a prefix that names exactly one entry. Picking the newest of several
  // matches would restore something the user did not ask for.
  if (!id) return { ok: false, why: 'no trash id given' };
  const all = trashList();
  const matches = all.some((x) => x.id === id) ? all.filter((x) => x.id === id) : all.filter((x) => x.id.startsWith(id));
  if (matches.length > 1) return { ok: false, why: `${matches.length} entries match "${id}"; use more of the id` };
  const e = matches[0];
  if (!e) return { ok: false, why: 'no such trash entry' };
  if (e.origin === '?') return { ok: false, why: 'origin unknown for this entry' };
  if (existsSync(e.origin)) return { ok: false, why: `${e.origin} already exists` };
  try {
    mkdirSync(path.dirname(e.origin), { recursive: true });
    try { renameImpl(e.path, e.origin); }
    catch (err) {
      // An entry trashed across volumes comes back the same way it went.
      if (err.code !== 'EXDEV') throw err;
      moveByCopy(e.path, e.origin);
    }
    rmSync(e.path + '.origin', { force: true });
    return { ok: true, origin: e.origin };
  } catch (err) { return { ok: false, why: err.message }; }
}
