/**
 * How big things are. du (or the Windows walk) is the most expensive thing chaff does, so
 * sizes are cached: artifacts by mtime with a ceiling, machine-wide stores by age.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { progress, run } from './exec.mjs';
import { IS_WIN, paths } from './paths.mjs';
import { duLines, treeBytes } from './platform/windows.mjs';

// ── sizes ─────────────────────────────────────────────────────────────────────

export let SIZE_CACHE = null;

export function loadSizeCache() {
  if (SIZE_CACHE) return SIZE_CACHE;
  try { SIZE_CACHE = JSON.parse(readFileSync(paths.sizeCache, 'utf8')); } catch { SIZE_CACHE = {}; }
  return SIZE_CACHE;
}

export function saveSizeCache() {
  if (!SIZE_CACHE) return;
  try { mkdirSync(paths.chaffHome, { recursive: true }); writeFileSync(paths.sizeCache, JSON.stringify(SIZE_CACHE)); }
  catch { /* best effort */ }
}

/**
 * Size many directories, reusing a previous measurement when the directory has not been
 * touched since. `du` on a large tree is the single most expensive thing chaff does, and a
 * build directory that nothing has written to cannot have changed size — so measure it once.
 *
 * The mtime of a directory changes when an entry is added or removed directly inside it.
 * A write deep inside a subtree does not bump the root's mtime, so the cache is also given
 * a ceiling: anything older than `maxAgeSec` is re-measured regardless.
 */
export function dirSizesMb(paths, label = 'paths', { maxAgeSec = 6 * 3600 } = {}) {
  const sizes = new Map();
  const cache = loadSizeCache();
  const now = Date.now();
  const stale = [];

  for (const p of paths) {
    let mtime = null;
    try { mtime = statSync(p).mtimeMs; } catch { continue; }   // vanished mid-scan
    const hit = cache[p];
    if (hit && hit.mtime === mtime && (now - hit.at) / 1000 < maxAgeSec) sizes.set(p, hit.mb);
    else stale.push({ path: p, mtime });
  }

  const reused = sizes.size;
  const CHUNK = 150;
  for (let i = 0; i < stale.length; i += CHUNK) {
    if (stale.length > CHUNK) {
      progress(`sizing ${label}… ${Math.min(i + CHUNK, stale.length)}/${stale.length}` +
        (reused ? ` (${reused} unchanged, reused)` : ''));
    }
    const batch = stale.slice(i, i + CHUNK);
    const out = IS_WIN ? duLines(batch.map((b) => b.path)) : run('du', ['-sk', ...batch.map((b) => b.path)], { timeout: 180_000 });
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const mb = Math.round(+m[1] / 1024);
      sizes.set(m[2], mb);
      const rec = batch.find((b) => b.path === m[2]);
      if (rec) cache[m[2]] = { mb, mtime: rec.mtime, at: now };
    }
  }

  // Keep the cache from growing without bound as worktrees come and go.
  const keys = Object.keys(cache).filter((k) => k !== 'stores');
  if (keys.length > 20000) {
    for (const k of keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - 15000)) delete cache[k];
  }
  saveSizeCache();
  return sizes;
}

/** Does `dir` contain `marker` (supports a leading *.ext glob)? */
export function hasMarker(dir, marker) {
  try {
    if (!marker.startsWith('*')) return existsSync(path.join(dir, marker));
    const ext = marker.slice(1);
    return readdirSync(dir).some((f) => f.endsWith(ext));
  } catch { return false; }
}

export const STORE_SIZE_TTL_SEC = 24 * 3600;

/**
 * Sizes of the shared stores, each `{ mb, at, reused }`. Kept apart from the artifact size
 * cache because the rule differs: a store's root mtime says nothing about the writes deep
 * inside it, so the only freshness signal is age. `refresh` measures everything again.
 */
export function storeSizesMb(paths, { refresh = false, ttlSec = STORE_SIZE_TTL_SEC, now = Date.now() } = {}) {
  const cache = loadSizeCache();
  cache.stores ??= {};
  const out = new Map();
  for (const p of paths) {
    const hit = cache.stores[p];
    if (!refresh && hit && Number.isFinite(hit.mb) && now - hit.at >= 0 && (now - hit.at) / 1000 < ttlSec) {
      out.set(p, { mb: hit.mb, at: hit.at, reused: true });
      continue;
    }
    const mb = dirSizeMb(p);
    cache.stores[p] = { mb, at: now };
    out.set(p, { mb, at: now, reused: false });
  }
  saveSizeCache();
  return out;
}

export function dirSizeMb(p) {
  if (!existsSync(p)) return 0;
  if (IS_WIN) return Math.round(treeBytes(p) / 1048576);
  const kb = parseInt(run('du', ['-sk', p], { timeout: 120_000 }).trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
}

/** Seconds since the most recent write at or one level below `dir`; null if absent. */
export function newestWriteSec(dir, now) {
  if (!existsSync(dir)) return null;
  let newest = 0;
  try {
    newest = statSync(dir).mtimeMs;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      try {
        const m = statSync(path.join(dir, entry.name)).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* raced with a delete */ }
    }
  } catch { return null; }
  return Math.max(0, (now - newest) / 1000);
}
