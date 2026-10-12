/**
 * The scan: one inventory of projects, artifacts, processes, stores, worktrees and disk,
 * behind a lock so concurrent callers never stack full scans, and cached for the statusline
 * and hooks.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACTS, CLASSIFIERS, STORES, isDaemon, isWork } from './catalog.mjs';
import { DEFAULTS } from './config.mjs';
import { discoverArtifacts, discoverDeps, discoverProjects, markTracked, resolveRoots } from './discover.mjs';
import { isAlive, progress, progressDone, run } from './exec.mjs';
import { defaultBranchFor, isDirty, lastCommitDays, mergedBranches, worktreesFor } from './git.mjs';
import { IS_WIN, paths } from './paths.mjs';
import { windowsDisk } from './platform/windows.mjs';
import { allProcessCwds, attributeByCwd, snapshotProcesses, withinRoots } from './processes.mjs';
import { dirSizesMb, hasMarker, newestWriteSec, storeSizesMb } from './sizes.mjs';

// node_modules only changes on install, and measuring it is slow, so its own cache lives a day.
export const DEPS_MAX_AGE_SEC = 24 * 3600;

// ── scan lock ─────────────────────────────────────────────────────────────────
//
// A full scan walks three roots and can take half a minute. Without a lock, anything that
// triggers a background refresh on a timer (the statusline) will happily start a second
// scan while the first is still going, then a third, until the machine is on its knees.
// Exactly one scan may run at a time, per machine.

/** Take the scan lock, or return null if another live scan already holds it. */
export function acquireLock({ maxAgeSec = 600 } = {}) {
  mkdirSync(paths.chaffHome, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists, which makes taking the lock atomic.
      writeFileSync(paths.lock, payload, { flag: 'wx' });
      return paths.lock;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    // Someone holds it. Decide whether they are still alive.
    let holder = null;
    try { holder = JSON.parse(readFileSync(paths.lock, 'utf8')); } catch { /* unreadable */ }
    const alive = holder?.pid ? isAlive(holder.pid) : false;
    const ageSec = holder?.at ? (Date.now() - holder.at) / 1000 : Infinity;
    if (alive && ageSec < maxAgeSec) return null;      // a real scan is in progress
    try { unlinkSync(paths.lock); } catch { /* raced */ }  // stale: clear it and retry once
  }
  return null;
}

/** True when a live scan currently holds the lock. */
export function scanInProgress() {
  try {
    const h = JSON.parse(readFileSync(paths.lock, 'utf8'));
    return !!(h?.pid && isAlive(h.pid) && (Date.now() - h.at) / 1000 < 600);
  } catch { return false; }
}

export function releaseLock(lock) {
  if (!lock) return;
  try {
    const holder = JSON.parse(readFileSync(lock, 'utf8'));
    if (holder.pid === process.pid) unlinkSync(lock);
  } catch { /* already gone */ }
}


// ── disk ──────────────────────────────────────────────────────────────────────

export function diskFor(dir) {
  if (IS_WIN) return windowsDisk(dir);
  const f = (run('df', ['-k', dir]).trim().split('\n').pop() || '').split(/\s+/);
  const totalGb = +f[1] / 1024 / 1024, usedGb = +f[2] / 1024 / 1024, freeGb = +f[3] / 1024 / 1024;
  return {
    totalGb: +totalGb.toFixed(1), usedGb: +usedGb.toFixed(1), freeGb: +freeGb.toFixed(1),
    pctUsed: totalGb ? Math.round((usedGb / totalGb) * 100) : 0,
  };
}

// ── scan ──────────────────────────────────────────────────────────────────────

/**
 * Run a full scan under the lock. Returns null when another scan already holds it —
 * callers fall back to the cache rather than piling on.
 */
export function scan(cfg, opts = {}) {
  const lock = acquireLock();
  if (!lock) return null;
  const release = () => releaseLock(lock);
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { release(); process.exit(1); });
  try { return performScan(cfg, opts); } finally { release(); }
}

export function performScan(cfg, { deep = false } = {}) {
  const { roots, inferred: rootsInferred, refused: rootsRefused } = resolveRoots(cfg);
  const now = Date.now();
  const abandonedSec = (cfg.abandonedWorkHours ?? DEFAULTS.abandonedWorkHours) * 3600;

  progress('finding projects…');
  const markers = discoverProjects(roots, cfg.maxScanDepth);
  const projectRoots = [...markers.keys()].sort();
  progress(`found ${markers.size} projects · finding build artifacts…`);
  const artifactPaths = discoverArtifacts(roots, cfg.maxArtifactDepth, cfg.includeOutputs);
  progress(`found ${artifactPaths.length} artifacts · reading processes…`);
  const procs = snapshotProcesses();
  // A command line is not a path: projectFromCmd stops at the first space, so VS Code's
  // bundled tsserver (`/Applications/Visual Studio Code.app/…`) or a repo under "My
  // Projects" yields a fragment that does not exist — which tier 1 reads as "project
  // deleted" and kills. Only trust an attribution inside a root we actually scanned.
  for (const p of procs) if (p.project && !withinRoots(p.project, roots)) p.project = null;
  attributeByCwd(procs, projectRoots);

  // Size every artifact in one batched pass.
  progress(`sizing ${artifactPaths.length} artifacts…`);
  const sizes = dirSizesMb(artifactPaths, 'artifacts');

  // node_modules is usually the single largest thing on disk, and skipping it makes every
  // total a serious undercount. Walking it is expensive, so it is opt-in — but when it is
  // off we say so, rather than quietly reporting a number that is far too small.
  const measureDeps = deep || cfg.sizeMode === 'full';
  if (measureDeps) progress('finding node_modules…');
  const depPaths = measureDeps ? discoverDeps(roots, cfg.maxArtifactDepth) : [];
  const depSizes = measureDeps ? dirSizesMb(depPaths, 'node_modules') : new Map();

  // Reuse a recent measurement when this run did not take one itself.
  let depsCache = null;
  if (!measureDeps) {
    try {
      const c = JSON.parse(readFileSync(paths.depsCache, 'utf8'));
      if ((now - c.at) / 1000 < DEPS_MAX_AGE_SEC) depsCache = c;
    } catch { /* none yet */ }
  }
  const full = measureDeps || !!depsCache;

  // Attribute each artifact to the deepest project root that contains it.
  const byProject = new Map(projectRoots.map((r) => [r, []]));
  const sortedRoots = [...projectRoots].sort((a, b) => b.length - a.length);
  const orphanArtifacts = [];
  for (const ap of artifactPaths) {
    const owner = sortedRoots.find((r) => ap === r || ap.startsWith(r + path.sep));
    const meta = ARTIFACTS[path.basename(ap)];
    // Marker-gated artifacts (target, obj, Library, …) are only counted when the parent
    // directory really is a project of that kind. Being wrong here means deleting source.
    if (meta.requires && !meta.requires.some((m) => hasMarker(path.dirname(ap), m))) continue;
    const tool = meta.refine?.find((r) => r.requires.some((m) => hasMarker(path.dirname(ap), m)))?.tool ?? meta.tool;
    const rec = {
      path: ap, tool, category: meta.category,
      sizeMb: sizes.get(ap) ?? 0, lastWriteSec: newestWriteSec(ap, now),
    };
    if (owner) byProject.get(owner).push(rec); else orphanArtifacts.push(rec);
  }

  // `build/` and `dist/` are also ordinary directory names: golang-standards keeps Dockerfiles
  // and CI in build/, and GitHub Actions repos commit dist/. Anything git tracks is source,
  // not output, whatever it is called and however long since it changed.
  for (const [root, arts] of byProject) markTracked(root, arts);

  const liveProjects = new Set(procs.map((p) => p.project).filter(Boolean));

  const depsByProject = new Map(depsCache ? Object.entries(depsCache.byProject) : []);
  for (const dp of depPaths) {
    const owner = sortedRoots.find((r) => dp.startsWith(r + path.sep));
    if (!owner) continue;
    depsByProject.set(owner, (depsByProject.get(owner) || 0) + (depSizes.get(dp) ?? 0));
  }
  if (measureDeps) {
    try {
      mkdirSync(paths.chaffHome, { recursive: true });
      writeFileSync(paths.depsCache, JSON.stringify({ at: now, byProject: Object.fromEntries(depsByProject) }));
    } catch { /* best effort */ }
  }
  const depsAgeSec = measureDeps ? 0 : depsCache ? (now - depsCache.at) / 1000 : null;

  const projects = projectRoots.map((root) => {
    const arts = byProject.get(root) || [];
    const mine = procs.filter((p) => p.project === root);
    const kinds = [...markers.get(root)];
    const cacheMb = arts.filter((a) => a.category === 'cache').reduce((s, a) => s + a.sizeMb, 0);
    const outputMb = arts.filter((a) => a.category === 'output').reduce((s, a) => s + a.sizeMb, 0);
    return {
      root, name: path.basename(root), kinds, exists: existsSync(root),
      isWorktree: /\/\.claude\/worktrees\//.test(root) || !existsSync(path.join(root, '.git', 'config')),
      artifacts: arts, cacheMb, outputMb,
      nodeModulesMb: full ? (depsByProject.get(root) ?? 0) : null,
      nxVersion: (mine.find((p) => /nx@[\d.]+/.test(p.cmd))?.cmd.match(/nx@([\d.]+)/) || [])[1] || null,
      lastCommitDays: lastCommitDays(root),
      procCount: mine.length,
      rssMb: mine.reduce((s, p) => s + p.rssMb, 0),
      daemons: mine.filter((p) => isDaemon(p.type)).map((p) => p.pid),
      // "Active" has to mean recently active. Keying it on the mere existence of a work
      // process let one forgotten dev server mark a monorepo active forever, which held
      // every artifact in it out of tier 2 — the abandoned process protected the garbage
      // it was not using.
      active: mine.some((p) => isWork(p.type) && p.ageSec < abandonedSec),
      abandoned: mine.filter((p) => isWork(p.type) && p.ageSec >= abandonedSec).map((p) => p.pid),
      live: liveProjects.has(root),
    };
  });

  // Shared machine-wide stores. Sizing them is most of a cold scan (a pnpm store alone can
  // take 20s+), and they change slowly, so a measurement is reused for a day. --deep
  // re-measures. A reused size never decides a cleanup on its own: see prune-store in applyPlan.
  progress('sizing shared stores…');
  const storeDefs = [];
  // CHAFF_STORES=none skips the machine-wide stores. Tests use it: `pnpm store path` ignores
  // $HOME, so without it a test sizes the developer's real multi-GB store and its result
  // depends on whose machine it ran on.
  for (const def of process.env.CHAFF_STORES === 'none' ? [] : STORES) {
    let p = '';
    try { p = def.resolve(); } catch { continue; }
    if (!p || !existsSync(p)) continue;
    storeDefs.push({ def, path: p });
  }
  const storeSizes = storeSizesMb(storeDefs.map((x) => x.path), { refresh: deep });
  const stores = storeDefs.map(({ def, path: p }) => ({
    name: def.name, path: p, sizeMb: storeSizes.get(p)?.mb ?? 0,
    sizedAt: new Date(storeSizes.get(p)?.at ?? Date.now()).toISOString(),
    reused: !!storeSizes.get(p)?.reused, prune: def.prune, safe: def.safe,
  }));

  // Worktrees, from every project that is a real git repo.
  progress('reading git worktrees…');
  const worktrees = [];
  const seen = new Set();
  // A shell or an editor sitting in a worktree is someone working there, even with nothing
  // building. Toolchain attribution never sees those, so read every process's cwd once.
  const cwds = projectRoots.some((r) => markers.get(r).has('git')) ? allProcessCwds() : [];
  const repoMeta = new Map(); // repo -> { base, merged } — computed once per repo, not per worktree
  for (const root of projectRoots) {
    if (!markers.get(root).has('git')) continue;
    if (!repoMeta.has(root)) {
      const base = defaultBranchFor(root);
      repoMeta.set(root, { base, merged: mergedBranches(root, base) });
    }
    const { base, merged } = repoMeta.get(root);
    for (const wt of worktreesFor(root)) {
      if (seen.has(wt.path)) continue;
      seen.add(wt.path);
      const exists = existsSync(wt.path);
      const arts = byProject.get(wt.path) || [];
      const ageDays = exists ? lastCommitDays(wt.path) : null;
      // lsof reports resolved paths; git reports the path as it was added. Behind a symlink
      // (macOS /var → /private/var, a code folder linked from elsewhere) the two never match.
      let realWt = wt.path;
      try { realWt = realpathSync(wt.path); } catch { /* gone */ }
      const under = (c, base) => c === base || c.startsWith(base + path.sep);
      // Windows offers no cheap way to read another process's working directory, so a shell
      // or editor sitting in a worktree is invisible there. Unknown is not idle: count it busy.
      const busy = procs.some((p) => p.project === wt.path || p.cmd.includes(wt.path))
        || cwds.some((c) => under(c, wt.path) || under(c, realWt)) || IS_WIN;
      const isMerged = !!(exists && wt.branch && merged.has(wt.branch));
      // `git status` is the expensive probe. Only run it where the answer can change the
      // plan: a merged, stale, idle, unlocked, non-primary worktree. Everywhere else the
      // worktree is tier 3 regardless, so leave it null (= unknown, treated as unsafe).
      const worthChecking = exists && !wt.isPrimary && !wt.locked && !busy && isMerged
        && (ageDays ?? 0) >= cfg.staleWorktreeDays;
      const dirty = worthChecking ? isDirty(wt.path) : null;
      worktrees.push({
        ...wt, repo: root, exists, isPrimary: !!wt.isPrimary, baseBranch: base, ageDays,
        merged: isMerged,
        dirty,
        hasProcess: busy,
        ...(IS_WIN ? { busyUnknown: true } : {}),
        cacheMb: arts.reduce((s, a) => s + a.sizeMb, 0),
      });
    }
  }

  // Every classified toolchain process, not just node — a JVM or a Unity Editor eating
  // 8GB was previously invisible because it fell through to 'other'.
  const TOOLCHAIN = new Set(CLASSIFIERS.map((c) => c.type).filter((t) => t !== 'claude'));
  const nodeProcs = procs.filter((p) => TOOLCHAIN.has(p.type));
  const totals = {
    nodeProcs: nodeProcs.length,
    nodeRssMb: nodeProcs.reduce((s, p) => s + p.rssMb, 0),
    claudeProcs: procs.filter((p) => p.type === 'claude').length,
    daemons: procs.filter((p) => isDaemon(p.type)).length,
    projects: projects.length,
    worktrees: worktrees.length,
    cacheMb: projects.reduce((s, p) => s + p.cacheMb, 0) + orphanArtifacts.filter((a) => a.category === 'cache').reduce((s, a) => s + a.sizeMb, 0),
    outputMb: projects.reduce((s, p) => s + p.outputMb, 0) + orphanArtifacts.filter((a) => a.category === 'output').reduce((s, a) => s + a.sizeMb, 0),
    storeMb: stores.reduce((s, x) => s + x.sizeMb, 0),
    depsMb: full ? projects.reduce((s, p) => s + (p.nodeModulesMb || 0), 0) : null,
    sizeMode: full ? 'full' : 'fast',
    depsAgeSec,
  };

  progressDone();
  return {
    schema: 2, scannedAt: new Date(now).toISOString(), roots, rootsInferred, rootsRefused,
    config: { policy: cfg.policy, thresholds: cfg.thresholds },
    disk: diskFor(roots[0] || paths.home),
    totals, projects, stores, worktrees, orphanArtifacts, processes: procs,
  };
}

// ── scan cache ────────────────────────────────────────────────────────────────

export function readCache() {
  try {
    const c = JSON.parse(readFileSync(paths.scanCache, 'utf8'));
    return c.schema === 2 ? c : null;
  } catch { return null; }
}

export function writeCache(s) {
  try { mkdirSync(paths.chaffHome, { recursive: true }); writeFileSync(paths.scanCache, JSON.stringify(s)); }
  catch { /* best effort */ }
}

export function cachedScan(cfg, opts) {
  const c = readCache();
  if (c && (Date.now() - new Date(c.scannedAt).getTime()) / 1000 < cfg.scanTtlSeconds) return c;
  const fresh = scan(cfg, opts);
  if (fresh) { writeCache(fresh); return fresh; }
  // Another scan holds the lock. Serve whatever we have rather than starting a second one.
  if (c) return c;
  process.stderr.write('chaff: a scan is already running; try again in a moment\n');
  process.exit(3);
}
