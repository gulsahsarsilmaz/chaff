#!/usr/bin/env node
/**
 * chaff — separate the live work from the dead weight on a developer machine.
 *
 * Inventories node processes, build caches, build outputs, package-manager stores and git
 * worktrees across every JS/TS project under your roots, attributes each one to the project
 * it belongs to, and sorts cleanup into three safety tiers.
 *
 *   scan        inventory everything            (--json, --deep, --fresh)
 *   plan        tiered cleanup plan, read-only  (--json)
 *   apply       execute a plan                  (--tier=N, --yes, --force, --dry-run)
 *   statusline  one-line pressure summary
 *   mcp         serve the MCP protocol over stdio (any agent)
 *   config      show / set configuration
 *
 * No dependencies. Node >= 18.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureStatusline, removeStatusline, statuslineCommand } from './statusline-setup.mjs';
import path from 'node:path';

const HOME = homedir();
const CHAFF_HOME = process.env.CHAFF_HOME || path.join(HOME, '.chaff');
const CONFIG_PATH = path.join(CHAFF_HOME, 'config.json');
const CACHE_PATH = path.join(CHAFF_HOME, 'scan-cache.json');
const LOCK_PATH = path.join(CHAFF_HOME, 'scan.lock');
// node_modules only changes on install, and measuring it is slow. Keep it in its own
// longer-lived cache so an ordinary fast scan never destroys a measurement that took
// two minutes to produce.
const DEPS_PATH = path.join(CHAFF_HOME, 'deps-cache.json');
const DEPS_MAX_AGE_SEC = 24 * 3600;
const TRASH_DIR = path.join(CHAFF_HOME, 'trash');
const SIZE_CACHE_PATH = path.join(CHAFF_HOME, 'size-cache.json');
const XDG_CACHE = process.env.XDG_CACHE_HOME || path.join(HOME, '.cache');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// Runners set CI=true almost universally. There, disk is billed and a job that dies at 95%
// because the volume filled costs real money, so chaff defaults to terse, parseable output.
const IS_CI = !!process.env.CI && process.env.CI !== 'false';

/**
 * chaff's inventory comes from `find`, `du`, `df` and `ps`. On Windows none of those mean
 * what they mean here — `find.exe` searches text inside files rather than walking a tree —
 * so a scan there does not fail loudly, it silently returns almost nothing. Handing an empty
 * inventory to a cleanup planner is the one failure mode this tool cannot have, so anything
 * that depends on a scan refuses outright. `help`, `config` and the MCP handshake still work.
 *
 * Windows support means porting the scan layer to PowerShell and verifying it on real
 * Windows. Until someone does that, refusing is the honest answer.
 */
function requirePosixScan(sub) {
  if (!IS_WIN) return;
  process.stderr.write(
    `chaff: ${sub} needs a POSIX scan layer (find, du, df, ps), which Windows does not provide.\n\n`
    + '  Run chaff inside WSL, where it works normally:\n'
    + '      wsl\n'
    + '      npm install -g chaff && chaff status\n\n'
    + '  Scanning the Windows filesystem from WSL via /mnt/c is slow enough to be useless,\n'
    + '  so point it at your WSL-side repos:\n'
    + '      chaff config --set=roots=["~/code"]\n\n'
    + '  Native Windows support is tracked at\n'
    + '  https://github.com/lockdownmedia/chaff/issues\n');
  process.exit(4);
}

/** First path in the list that exists, or '' — lets one entry cover several platforms. */
const firstExisting = (paths) => paths.find((p) => { try { return existsSync(p); } catch { return false; } }) || '';

// ── what counts as a project, and what each project leaves behind ──────────────

/** Files whose presence marks a directory as the root of a JS/TS project. */
const PROJECT_MARKERS = [
  'nx.json', 'turbo.json', 'pnpm-workspace.yaml', 'lerna.json', 'rush.json',  // JS/TS
  'Cargo.toml',                                                               // Rust
  'go.mod',                                                                   // Go
  '*.sln', '*.csproj',                                                        // .NET
  'build.gradle', 'build.gradle.kts', 'pom.xml',                              // JVM
  'pyproject.toml',                                                           // Python
  'ProjectSettings', '*.uproject',                                            // Unity / Unreal
  '.git',                                                                     // anything else
];

/**
 * Regenerable artifacts, by directory name.
 *   cache  — pure cache. Deleting costs a slower next build, nothing else.
 *   output — build output. Regenerable, but something may currently be serving it.
 */
const ARTIFACTS = {
  // ── JavaScript / TypeScript ────────────────────────────────────────────────
  '.nx':             { category: 'cache',  tool: 'nx' },
  '.turbo':          { category: 'cache',  tool: 'turbo' },
  '.angular':        { category: 'cache',  tool: 'angular' },
  '.parcel-cache':   { category: 'cache',  tool: 'parcel' },
  '.vite':           { category: 'cache',  tool: 'vite' },
  '.rollup.cache':   { category: 'cache',  tool: 'rollup' },
  '.rspack-cache':   { category: 'cache',  tool: 'rspack' },
  '.webpack-cache':  { category: 'cache',  tool: 'webpack' },
  '.cache':          { category: 'cache',  tool: 'generic' },
  '.next':           { category: 'output', tool: 'next' },
  '.svelte-kit':     { category: 'output', tool: 'sveltekit' },
  '.astro':          { category: 'output', tool: 'astro' },
  '.output':         { category: 'output', tool: 'nitro' },
  '.expo':           { category: 'output', tool: 'expo' },
  'dist':            { category: 'output', tool: 'build' },
  'build':           { category: 'output', tool: 'build' },
  'coverage':        { category: 'output', tool: 'coverage' },
  'storybook-static':{ category: 'output', tool: 'storybook' },

  // ── Rust / JVM ─────────────────────────────────────────────────────────────
  // `target` is Cargo's and Maven's build dir. Gated on a manifest so a directory
  // that merely happens to be called "target" is never touched.
  'target':          { category: 'output', tool: 'cargo/maven', requires: ['Cargo.toml', 'pom.xml'] },
  '.gradle':         { category: 'cache',  tool: 'gradle' },

  // ── .NET ───────────────────────────────────────────────────────────────────
  // `obj` only; `bin` is deliberately excluded — far too many repos keep real
  // scripts in bin/ for that to be safe.
  'obj':             { category: 'output', tool: 'dotnet', requires: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln'] },

  // ── Python ─────────────────────────────────────────────────────────────────
  '__pycache__':     { category: 'cache',  tool: 'python' },
  '.pytest_cache':   { category: 'cache',  tool: 'pytest' },
  '.mypy_cache':     { category: 'cache',  tool: 'mypy' },
  '.ruff_cache':     { category: 'cache',  tool: 'ruff' },
  '.tox':            { category: 'cache',  tool: 'tox' },

  // ── Game engines ───────────────────────────────────────────────────────────
  // Unity's Library/ is regularly the single largest directory on a dev machine.
  // Both are gated on engine markers, since "Library" and "Intermediate" are common words.
  'Library':          { category: 'cache',  tool: 'unity',  requires: ['ProjectSettings', 'Assets'] },
  'Temp':             { category: 'cache',  tool: 'unity',  requires: ['ProjectSettings', 'Assets'] },
  'Intermediate':     { category: 'cache',  tool: 'unreal', requires: ['*.uproject'] },
  'DerivedDataCache': { category: 'cache',  tool: 'unreal', requires: ['*.uproject'] },
  'Binaries':         { category: 'output', tool: 'unreal', requires: ['*.uproject'] },
};

const ARTIFACT_NAMES = Object.keys(ARTIFACTS);

/** Shared, machine-wide package-manager stores. Pruning is safe; re-download is the cost. */
const STORES = [
  { name: 'pnpm store',   resolve: () => run('pnpm', ['store', 'path']).trim(), prune: ['pnpm', 'store', 'prune'], safe: true },
  { name: 'npm cache',    resolve: () => path.join(HOME, '.npm', '_cacache'),   prune: ['npm', 'cache', 'clean', '--force'], safe: true },
  { name: 'yarn cache',   resolve: () => run('yarn', ['cache', 'dir']).trim(),  prune: ['yarn', 'cache', 'clean'], safe: true },
  // Re-downloading browser binaries is expensive and often offline-hostile: never automatic.
  { name: 'go module cache', resolve: () => run('go', ['env', 'GOMODCACHE']).trim() || path.join(HOME, 'go', 'pkg', 'mod'),
    prune: ['go', 'clean', '-modcache'], safe: true },
  { name: 'go build cache',  resolve: () => run('go', ['env', 'GOCACHE']).trim(), prune: ['go', 'clean', '-cache'], safe: true },
  { name: 'cargo registry',  resolve: () => path.join(HOME, '.cargo', 'registry'), prune: null, safe: false },
  { name: 'nuget packages',  resolve: () => firstExisting([path.join(HOME, '.nuget', 'packages')]),
    prune: ['dotnet', 'nuget', 'locals', 'global-packages', '--clear'], safe: true },
  { name: 'gradle caches',   resolve: () => path.join(HOME, '.gradle', 'caches'), prune: null, safe: false },
  { name: 'maven repository', resolve: () => path.join(HOME, '.m2', 'repository'), prune: null, safe: false },
  { name: 'pip cache',       resolve: () => firstExisting([
      path.join(XDG_CACHE, 'pip'), path.join(HOME, 'Library', 'Caches', 'pip')]),
    prune: ['pip', 'cache', 'purge'], safe: true },
  { name: 'playwright browsers', resolve: () => firstExisting([
      path.join(HOME, 'Library', 'Caches', 'ms-playwright'),          // macOS
      path.join(XDG_CACHE, 'ms-playwright'),                          // Linux
      path.join(HOME, 'AppData', 'Local', 'ms-playwright'),           // Windows
    ]), prune: null, safe: false },
  { name: 'puppeteer browsers',  resolve: () => firstExisting([
      path.join(HOME, '.cache', 'puppeteer'),
      path.join(XDG_CACHE, 'puppeteer'),
    ]), prune: null, safe: false },
];

// ── config ────────────────────────────────────────────────────────────────────

// A fixed RSS ceiling means different things on different machines: 4GB is most of an 8GB
// laptop and noise on a 64GB workstation, where the warning latches on and stays on until
// you stop reading it. Scale it to the machine; an explicit config value still wins.
const defaultRssMb = () => Math.max(4096, Math.round((totalmem() / 1048576) * 0.35));

export const DEFAULTS = {
  roots: [],
  policy: 'propose',            // 'propose' | 'auto-orphans' | 'auto-threshold'
  thresholds: {
    nodeRssMb: defaultRssMb(),  // ~35% of physical RAM, floor 4GB
    daemons: 4,
    diskFreeGb: 60,
    cacheGb: 3,
    worktrees: 25,
    storeGb: 10,
  },
  staleArtifactDays: 7,         // an artifact untouched this long is cold, whatever its repo is doing
  staleWorktreeDays: 7,
  idleDaemonMinutes: 90,
  abandonedWorkHours: 24,       // a build/dev-server older than this is abandoned, not in flight
  maxScanDepth: 6,              // depth for finding project roots
  maxArtifactDepth: 8,          // depth for finding build artifacts
  scanTtlSeconds: 20,
  includeOutputs: true,         // also track dist/build/.next, not just caches
  sizeMode: 'fast',             // 'fast' = named artifacts only | 'full' = + node_modules
  trash: true,                  // move deletions to ~/.chaff/trash instead of unlinking
  trashTtlDays: 7,              // purge trashed entries older than this
  progress: true,               // show scan progress on stderr when attached to a terminal
  statuslineStyle: 'color',     // 'color' = ANSI red/green text | 'dots' = emoji | 'plain' = no markers
  protect: [],
  autoStatusline: true,         // the Claude Code plugin installs chaff's statusline when there is none
};

function loadConfig() {
  let user = {};
  if (existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { warn(`config at ${CONFIG_PATH} is not valid JSON (${e.message}); using defaults`); }
  }
  // staleProjectDays measured the repo's commit recency; staleArtifactDays measures the
  // artifact's own. Honour the old key so an existing config keeps working.
  if (user.staleProjectDays != null && user.staleArtifactDays == null) {
    user = { ...user, staleArtifactDays: user.staleProjectDays };
  }
  // A hand-edited config is the likeliest malformed input chaff sees. A string where a list
  // belongs used to throw deep inside a scan; take a lone string as a one-item list, and drop
  // anything else with a warning rather than guess.
  for (const key of ['roots', 'protect']) {
    if (user[key] == null || Array.isArray(user[key])) continue;
    if (typeof user[key] === 'string') user = { ...user, [key]: [user[key]] };
    else { warn(`config "${key}" must be a list of paths; ignoring it`); user = { ...user, [key]: DEFAULTS[key] }; }
  }
  for (const key of ['roots', 'protect']) {
    if (Array.isArray(user[key]) && user[key].some((x) => typeof x !== 'string' || !x)) {
      warn(`config "${key}" may only hold non-empty paths; ignoring the rest`);
      user = { ...user, [key]: user[key].filter((x) => typeof x === 'string' && x) };
    }
  }
  return { ...DEFAULTS, ...user, thresholds: { ...DEFAULTS.thresholds, ...(user.thresholds || {}) } };
}

function saveConfig(cfg) {
  mkdirSync(CHAFF_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}


// ── scan lock ─────────────────────────────────────────────────────────────────
//
// A full scan walks three roots and can take half a minute. Without a lock, anything that
// triggers a background refresh on a timer (the statusline) will happily start a second
// scan while the first is still going, then a third, until the machine is on its knees.
// Exactly one scan may run at a time, per machine.

/** Take the scan lock, or return null if another live scan already holds it. */
export function acquireLock({ maxAgeSec = 600 } = {}) {
  mkdirSync(CHAFF_HOME, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists, which makes taking the lock atomic.
      writeFileSync(LOCK_PATH, payload, { flag: 'wx' });
      return LOCK_PATH;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    // Someone holds it. Decide whether they are still alive.
    let holder = null;
    try { holder = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); } catch { /* unreadable */ }
    const alive = holder?.pid ? isAlive(holder.pid) : false;
    const ageSec = holder?.at ? (Date.now() - holder.at) / 1000 : Infinity;
    if (alive && ageSec < maxAgeSec) return null;      // a real scan is in progress
    try { unlinkSync(LOCK_PATH); } catch { /* raced */ }  // stale: clear it and retry once
  }
  return null;
}

/** True when a live scan currently holds the lock. */
export function scanInProgress() {
  try {
    const h = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
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

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── shell ─────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout ?? 60_000,
      killSignal: 'SIGKILL', ...opts,
    });
  } catch { return ''; }
}

const warn = (m) => process.stderr.write(`chaff: ${m}\n`);

// ── progress ─────────────────────────────────────────────────────────────────
// A full scan can walk a very large tree. Silence for two minutes reads as a hang, so say
// what is happening — on stderr, so stdout stays pipeable, and only on a real terminal.
let PROGRESS_ON = false;
let progressLast = 0;
const progressEnabled = () => PROGRESS_ON && process.stderr.isTTY;

function setProgress(on) { PROGRESS_ON = on; }

function progress(msg) {
  if (!progressEnabled()) return;
  const line = `  ${msg}`.padEnd(Math.max(0, (process.stderr.columns || 80) - 1)).slice(0, (process.stderr.columns || 80) - 1);
  process.stderr.write(`\r${line}`);
  progressLast = Date.now();
}

function progressDone() {
  if (!progressEnabled() || !progressLast) return;
  process.stderr.write('\r' + ' '.repeat((process.stderr.columns || 80) - 1) + '\r');
  progressLast = 0;
}

// ── trash ────────────────────────────────────────────────────────────────────
//
// chaff's main verb is `rm -rf`. Everything it removes is regenerable in principle, but
// "in principle" is cold comfort the first time you run it on your own machine. Moving
// instead of unlinking costs one rename and makes the whole thing reversible.

/** Move `target` into the trash. Returns the trash path, or null if it could not. */
export function trashPath(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = target.replace(/^\/+/, '').replace(/[/\\]/g, '__');
  const dest = path.join(TRASH_DIR, `${stamp}__${slug}`);
  mkdirSync(TRASH_DIR, { recursive: true });
  try {
    renameSync(target, dest);
    writeFileSync(dest + '.origin', target);
    return dest;
  } catch (e) {
    // A rename cannot cross filesystems. Copying a 20GB target/ would be worse than the
    // delete it is meant to protect, so fall back rather than pretend.
    if (e.code === 'EXDEV') return null;
    throw e;
  }
}

/** Entries currently in the trash, newest first. */
export function trashList() {
  if (!existsSync(TRASH_DIR)) return [];
  return readdirSync(TRASH_DIR)
    .filter((f) => !f.endsWith('.origin'))
    .map((f) => {
      const full = path.join(TRASH_DIR, f);
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
    try { rmSync(e.path, { recursive: true, force: true }); rmSync(e.path + '.origin', { force: true }); n++; }
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
    renameSync(e.path, e.origin);
    rmSync(e.path + '.origin', { force: true });
    return { ok: true, origin: e.origin };
  } catch (err) { return { ok: false, why: err.message }; }
}
const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// ── discovery ─────────────────────────────────────────────────────────────────

/**
 * Which directories a scan walks. Configured `roots` win; otherwise they are inferred from
 * the cwd, and the result carries `inferred` so every renderer can say so — a silent
 * inference lets someone read "all clear" about a third of their machine.
 */
export function resolveRoots(cfg) {
  if (cfg.roots?.length) {
    const wanted = cfg.roots.map(expand);
    const found = wanted.filter(existsSync);
    // A typo in `roots` would otherwise scan nothing and cheerfully report all-clear.
    for (const miss of wanted.filter((r) => !found.includes(r))) warn(`configured root does not exist: ${miss}`);
    if (!found.length) {
      warn(`none of the configured roots exist — nothing to scan. Fix "roots" in ${CONFIG_PATH}`);
      process.exit(4);
    }
    return { roots: found, inferred: false, refused: null };
  }
  const cwd = process.cwd();
  const top = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).trim();
  const base = top || cwd;
  // Never infer a root at or above $HOME: a depth-6 walk of the home directory drags in
  // Library, Downloads and iCloud, costs minutes, and finds nothing worth cleaning.
  const atOrAboveHome = (p) => p === HOME || HOME.startsWith(p + path.sep);
  const cand = [...new Set([path.dirname(base), base])].filter((p) => !atOrAboveHome(p) && existsSync(p));
  if (!cand.length) {
    warn(`no project scan: ${base.replace(HOME, '~')} is at or above your home directory. `
      + `Set roots with: chaff config --set=roots=["~/code"]`);
    return { roots: [], inferred: true, refused: base };
  }
  return { roots: cand, inferred: true, refused: null };
}

/** Project roots under `roots`: anything carrying a project marker. node_modules is pruned. */
function discoverProjects(roots, maxDepth) {
  const markers = new Map(); // root -> Set of marker names
  for (const root of roots) {
    const nameArgs = [];
    PROJECT_MARKERS.forEach((m, i) => { if (i) nameArgs.push('-o'); nameArgs.push('-name', m); });
    const out = run('find', [
      root, '-maxdepth', String(maxDepth),
      '-name', 'node_modules', '-prune', '-o',
      '(', ...nameArgs, ')', '-print',
    ], { timeout: 180_000 });
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      const dir = path.dirname(p);
      const marker = path.basename(p);
      if (!markers.has(dir)) markers.set(dir, new Set());
      const KIND = { '.git': 'git', 'nx.json': 'nx', 'turbo.json': 'turbo', 'lerna.json': 'lerna',
                     'rush.json': 'rush', 'pnpm-workspace.yaml': 'pnpm' };
      markers.get(dir).add(KIND[marker] || marker);
    }
  }
  return markers;
}

/**
 * Flag the artifacts in `arts` that git tracks any file inside. One `git ls-files` per
 * project (batched), and a project outside any repo simply tracks nothing.
 */
export function markTracked(root, arts) {
  if (!arts.length) return;
  for (let i = 0; i < arts.length; i += 200) {
    const batch = arts.slice(i, i + 200);
    const rels = batch.map((a) => path.relative(root, a.path));
    const out = run('git', ['-C', root, 'ls-files', '-z', '--', ...rels], { timeout: 30_000 });
    if (!out) continue;
    const files = out.split('\0').filter(Boolean);
    batch.forEach((a, j) => {
      const rel = rels[j].split(path.sep).join('/');
      if (files.some((f) => f === rel || f.startsWith(rel + '/'))) a.tracked = true;
    });
  }
}

/** All regenerable artifact dirs under `roots`, in one pass. */
function discoverArtifacts(roots, maxDepth, includeOutputs) {
  const names = includeOutputs ? ARTIFACT_NAMES : ARTIFACT_NAMES.filter((n) => ARTIFACTS[n].category === 'cache');
  const nameArgs = [];
  names.forEach((n, i) => { if (i) nameArgs.push('-o'); nameArgs.push('-name', n); });
  const hits = [];
  for (const root of roots) {
    const out = run('find', [
      root, '-maxdepth', String(maxDepth),
      '-name', 'node_modules', '-prune', '-o',
      '-type', 'd', '(', ...nameArgs, ')', '-print', '-prune',
    ], { timeout: 240_000 });
    for (const line of out.split('\n')) if (line.trim()) hits.push(line.trim());
  }
  return hits;
}

/**
 * Top-level node_modules directories under `roots`. `-prune` after `-print` stops the walk
 * descending into nested installs, so each one is counted exactly once.
 */
function discoverDeps(roots, maxDepth) {
  const hits = [];
  for (const root of roots) {
    const out = run('find', [root, '-maxdepth', String(maxDepth), '-type', 'd', '-name', 'node_modules', '-print', '-prune'],
      { timeout: 240_000 });
    for (const line of out.split('\n')) if (line.trim()) hits.push(line.trim());
  }
  return hits;
}

/**
 * Size many directories at once. `du` accepts multiple paths and reports one line each,
 * which is dramatically faster than a process per directory.
 */
let SIZE_CACHE = null;

function loadSizeCache() {
  if (SIZE_CACHE) return SIZE_CACHE;
  try { SIZE_CACHE = JSON.parse(readFileSync(SIZE_CACHE_PATH, 'utf8')); } catch { SIZE_CACHE = {}; }
  return SIZE_CACHE;
}

function saveSizeCache() {
  if (!SIZE_CACHE) return;
  try { mkdirSync(CHAFF_HOME, { recursive: true }); writeFileSync(SIZE_CACHE_PATH, JSON.stringify(SIZE_CACHE)); }
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
    const out = run('du', ['-sk', ...batch.map((b) => b.path)], { timeout: 180_000 });
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
  const keys = Object.keys(cache);
  if (keys.length > 20000) {
    for (const k of keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - 15000)) delete cache[k];
  }
  saveSizeCache();
  return sizes;
}

/** Does `dir` contain `marker` (supports a leading *.ext glob)? */
function hasMarker(dir, marker) {
  try {
    if (!marker.startsWith('*')) return existsSync(path.join(dir, marker));
    const ext = marker.slice(1);
    return readdirSync(dir).some((f) => f.endsWith(ext));
  } catch { return false; }
}

function dirSizeMb(p) {
  if (!existsSync(p)) return 0;
  const kb = parseInt(run('du', ['-sk', p], { timeout: 120_000 }).trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
}

/** Seconds since the most recent write at or one level below `dir`; null if absent. */
function newestWriteSec(dir, now) {
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

// ── processes ─────────────────────────────────────────────────────────────────

export function etimeToSeconds(etime) {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d, h, mm, ss] = m;
  return (+(d || 0)) * 86400 + (+(h || 0)) * 3600 + (+mm) * 60 + (+ss);
}

/** First match wins, so the specific patterns must precede the general ones. */
const CLASSIFIERS = [
  { type: 'nx-daemon',    re: /\/nx\/(?:src|dist)\/daemon\/server\/start\.js/,     daemon: true },
  { type: 'nx-worker',    re: /\/nx\/(?:src|dist)\/project-graph\/plugins\// },
  { type: 'turbo-daemon', re: /\bturbod\b|\bturbo\b.*\bdaemon\b/,                  daemon: true },
  { type: 'tsserver',     re: /tsserver\.js|typescript\/lib\/tsserver/,            daemon: true },
  { type: 'watchman',     re: /\bwatchman\b/,                                      daemon: true },
  { type: 'metro',        re: /\bmetro\b/ },
  // nx ships its launcher at both nx/bin/nx.js and nx/dist/bin/nx.js depending on version;
  // matching only the first let `nx serve` fall through to the bare `node` catch-all.
  { type: 'nx-run',       re: /\/nx\/(dist\/)?bin\/nx\.js\s+\S/,                   work: true, reap: true },
  { type: 'esbuild',      re: /\/@esbuild\/[^/]+\/bin\/esbuild/,                   work: true, reap: true },
  { type: 'swc',          re: /\/@swc\/[^/]+\//,                                   work: true, reap: true },
  { type: 'typescript',   re: /\/typescript\/bin\/tsc\b|\btsc\b\s+--/,             work: true, reap: true },
  { type: 'test-runner',  re: /\b(jest|vitest|playwright|cypress|karma|mocha)\b/,  work: true, reap: true },
  { type: 'dev-server',   re: /\b(next|vite|webpack-dev-server|nodemon|ts-node-dev|storybook|wrangler|remix|astro)\b/, work: true, reap: true, server: true },
  { type: 'bundler',      re: /\b(webpack|rollup|parcel|tsup|rspack|turbo)\b/,     work: true, reap: true },
  { type: 'linter',       re: /\b(eslint|prettier|biome|stylelint)\b/,             work: true, reap: true },
  { type: 'pkg-manager',  re: /\b(pnpm|npm|yarn|npx|corepack)\b/ },
  { type: 'unity',        re: /Unity(\.app)?\/|UnityShaderCompiler|Unity Hub/,        work: true },
  { type: 'unreal',       re: /UnrealEditor|UE4Editor|UnrealBuildTool/,                work: true },
  // Only the build daemons are daemons. A bare `java -jar app.jar` is somebody's app — a
  // Spring Boot server, a Minecraft server — and classifying it as a daemon made tier 2
  // stop it whenever its project went quiet.
  { type: 'jvm',          re: /GradleDaemon|KotlinCompileDaemon|\bgradle\b/,           daemon: true },
  { type: 'java',         re: /\bjava\b/,                                              work: true },
  // Language servers are long-lived and hold gigabytes for hours: daemons, not work in
  // progress. Classifying them as work also made their project look active, which held
  // its artifacts out of tier 2 for as long as the editor stayed open. Ordered before the
  // go/rust/dotnet catch-alls, which would otherwise swallow them.
  { type: 'rust-analyzer', re: /\brust-analyzer\b/,                                     daemon: true },
  { type: 'gopls',         re: /\bgopls\b/,                                             daemon: true },
  { type: 'omnisharp',     re: /\bOmniSharp\b|Roslyn\S*LanguageServer/,                 daemon: true },
  { type: 'dotnet',       re: /\bdotnet\b|MSBuild/,                                     work: true },
  { type: 'go',           re: /\bgo (build|run|test|vet)\b|compile -o/,                work: true },
  { type: 'rust',         re: /\b(cargo|rustc)\b/,                                      work: true },
  { type: 'python',       re: /\b(python3?|pytest|uvicorn|gunicorn)\b/,                work: true },
  { type: 'claude',       re: /(^|\/)claude(\s|$)/ },
  // A compiled server — `node dist/apps/api/main.js` — is the most commonly forgotten
  // long-running process there is, and the bare `node` catch-all below never made it a
  // cleanup candidate. Only count an entrypoint inside a build directory, and never one
  // under node_modules, where this pattern would match half the toolchain.
  { type: 'node-server',  re: /^(?!.*node_modules).*\bnode\b.*[\s/](dist|build|out)\/\S*\.(c|m)?js\b/, work: true, reap: true, server: true },
  { type: 'node',         re: /\bnode\b/ },
];
const BY_TYPE = Object.fromEntries(CLASSIFIERS.map((c) => [c.type, c]));
const isDaemon = (t) => !!BY_TYPE[t]?.daemon;
// A server is something a person started and walked away from; a helper (esbuild, swc,
// tsc, a test worker) is spawned by whatever is running now. Age condemns a server on its
// own, but a helper is only ever garbage when its project has gone quiet too.
const isServer = (p) => !!BY_TYPE[p.type]?.server || (p.type === 'nx-run' && /\bserve\b/.test(p.cmd));
const isWork = (t) => !!BY_TYPE[t]?.work;
// What tier 2 may stop for being old: dev tooling that restarts in seconds. A Unity or
// Unreal editor, a `dotnet run`, a Jupyter server or a `cargo run` app can be up for days on
// purpose, and age says nothing about whether someone still needs it.
const isReapable = (t) => !!BY_TYPE[t]?.reap;

export function classify(cmd) {
  for (const c of CLASSIFIERS) if (c.re.test(cmd)) return c.type;
  return 'other';
}

/** True when `p` is one of `roots` or sits beneath one. */
export const withinRoots = (p, roots) => roots.some((r) => p === r || p.startsWith(r + path.sep));

/** Extract a project path from an absolute `.../<project>/node_modules/...` argument. */
export function projectFromCmd(cmd) {
  const m = cmd.match(/(\/[^\s]+?)\/node_modules\//);
  return m ? m[1] : null;
}

/**
 * Attribution reads the command line, which only carries a project when the binary was
 * launched through node_modules. A server started with a relative path — `node
 * dist/apps/api/main.js` — belongs to nothing, and a process with no project is skipped by
 * every tier, so the longest-running servers were also the most invisible. Their working
 * directory is the missing link. Only the unattributed ones need looking up, and one lsof
 * call covers all of them, so the cost stays flat.
 */
function attributeByCwd(procs, projectRoots) {
  const need = procs.filter((p) => !p.project && (isWork(p.type) || isDaemon(p.type)));
  if (!need.length || process.platform === 'win32') return;
  const raw = run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', need.map((p) => p.pid).join(',')]);
  if (!raw) return;
  const cwds = new Map();
  let pid = null;
  for (const line of raw.split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1));
  }
  // A cwd may sit below the project root; take the deepest root that contains it.
  const byDepth = [...projectRoots].sort((a, b) => b.length - a.length);
  for (const p of need) {
    const cwd = cwds.get(p.pid);
    if (!cwd) continue;
    p.project = byDepth.find((r) => cwd === r || cwd.startsWith(r + path.sep)) ?? null;
  }
}

/** The working directory of every process we can see. One lsof call; [] where unavailable. */
function allProcessCwds() {
  if (process.platform === 'win32') return [];
  const raw = run('lsof', ['-d', 'cwd', '-Fn'], { timeout: 20_000 });
  return raw.split('\n').filter((l) => l[0] === 'n').map((l) => l.slice(1));
}

function snapshotProcesses() {
  const raw = run('ps', ['-Ao', 'pid=,ppid=,rss=,%cpu=,etime=,command=']);
  const procs = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, rss, cpu, etime, cmd] = m;
    if (+pid === process.pid) continue;
    const type = classify(cmd);
    procs.push({
      pid: +pid, ppid: +ppid, rssMb: Math.round(+rss / 1024), cpu: +cpu,
      ageSec: etimeToSeconds(etime), cmd, type, project: projectFromCmd(cmd),
    });
  }
  // Attribute along the process tree in both directions: package-manager shims carry no
  // project path of their own and only learn it from the child they spawned.
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (const p of procs) {
    if (p.project) continue;
    let cur = byPid.get(p.ppid), hops = 0;
    while (cur && hops++ < 12) {
      if (cur.project) { p.project = cur.project; break; }
      cur = byPid.get(cur.ppid);
    }
  }
  for (const p of procs) {
    if (p.project) continue;
    const kid = procs.find((k) => k.ppid === p.pid && k.project);
    if (kid) p.project = kid.project;
  }
  return procs;
}

// ── git worktrees ─────────────────────────────────────────────────────────────

function worktreesFor(repo) {
  const out = run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { timeout: 30_000 });
  if (!out) return [];
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9), branch: null, locked: false, prunable: false, detached: false };
    } else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line === 'detached') cur.detached = true;
  }
  if (cur) list.push(cur);
  // `git worktree list` always reports the main working copy first. It can never be
  // removed with `git worktree remove`, so it must never appear in a removal plan.
  if (list[0]) list[0].isPrimary = true;
  return list;
}

/** The repo's default branch, e.g. "main". Cached per repo by the caller. */
export function defaultBranchFor(repo) {
  const head = run('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeout: 10_000 }).trim();
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) {
    if (run('git', ['-C', repo, 'rev-parse', '--verify', `refs/heads/${b}`], { timeout: 10_000 }).trim()) return b;
  }
  return null;
}

/** Branches fully merged into `base` — their commits are already in the mainline. */
export function mergedBranches(repo, base) {
  if (!base) return new Set();
  const ref = run('git', ['-C', repo, 'rev-parse', '--verify', `refs/remotes/origin/${base}`], { timeout: 10_000 }).trim()
    ? `origin/${base}` : base;
  const out = run('git', ['-C', repo, 'branch', '--merged', ref, '--format=%(refname:short)'], { timeout: 30_000 });
  return new Set(out.split('\n').map((x) => x.trim()).filter(Boolean));
}

/**
 * True when the working tree has uncommitted changes, false when clean, null when we could
 * not tell in time. `git status` walks the whole tree, so on a large monorepo it is by far
 * the most expensive probe here — only call it for worktrees that are actually removal
 * candidates, and treat "unknown" as unsafe rather than clean.
 */
export function isDirty(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000,
    });
    return out.trim().length > 0;
  } catch { return null; }
}

const lastCommitDays = (dir) => {
  const ts = run('git', ['-C', dir, 'log', '-1', '--format=%ct'], { timeout: 15_000 }).trim();
  return ts ? (Date.now() / 1000 - +ts) / 86400 : null;
};

// ── disk ──────────────────────────────────────────────────────────────────────

function diskFor(dir) {
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
function scan(cfg, opts = {}) {
  const lock = acquireLock();
  if (!lock) return null;
  const release = () => releaseLock(lock);
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { release(); process.exit(1); });
  try { return performScan(cfg, opts); } finally { release(); }
}

function performScan(cfg, { deep = false } = {}) {
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
      const c = JSON.parse(readFileSync(DEPS_PATH, 'utf8'));
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
    const rec = {
      path: ap, tool: meta.tool, category: meta.category,
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
      mkdirSync(CHAFF_HOME, { recursive: true });
      writeFileSync(DEPS_PATH, JSON.stringify({ at: now, byProject: Object.fromEntries(depsByProject) }));
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

  // Shared machine-wide stores.
  progress('sizing shared stores…');
  const stores = [];
  for (const def of STORES) {
    let p = '';
    try { p = def.resolve(); } catch { continue; }
    if (!p || !existsSync(p)) continue;
    stores.push({ name: def.name, path: p, sizeMb: dirSizeMb(p), prune: def.prune, safe: def.safe });
  }

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
      const busy = procs.some((p) => p.project === wt.path || p.cmd.includes(wt.path))
        || cwds.some((c) => under(c, wt.path) || under(c, realWt));
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
    disk: diskFor(roots[0] || HOME),
    totals, projects, stores, worktrees, orphanArtifacts, processes: procs,
  };
}

// ── plan ──────────────────────────────────────────────────────────────────────

export function buildPlan(s, cfg) {
  const actions = [];
  // What each pid was when the plan was made. A plan can be built from a scan minutes old,
  // and a pid freed since may now belong to something else entirely; applyPlan checks this
  // before it signals anything.
  const cmdOf = new Map(s.processes.map((p) => [p.pid, p.cmd]));
  const expectFor = (cmd) => Object.fromEntries(cmd.filter((x) => /^\d+$/.test(x) && cmdOf.has(+x)).map((x) => [x, cmdOf.get(+x)]));
  const isProtected = (p) => (cfg.protect || []).some((frag) => p.includes(frag));
  const add = (a) => {
    if (isProtected(a.target)) return;
    if (a.cmd?.[0] === 'kill') a.expect = expectFor(a.cmd);
    actions.push(a);
  };
  const staleSec = cfg.staleArtifactDays * 86400;
  const abandonedSec = cfg.abandonedWorkHours * 3600;

  // ── tier 1: provably dead ───────────────────────────────────────────────────
  for (const p of s.processes) {
    // Only toolchain processes. Attribution propagates along the process tree, so a shell,
    // an editor or a bare `node` can inherit a project from a child — and none of those is
    // ours to kill on the strength of a missing directory.
    if (p.type === 'claude' || !p.project || !(isWork(p.type) || isDaemon(p.type))) continue;
    if (!withinRoots(p.project, s.roots || [])) continue;
    if (!existsSync(p.project)) {
      add({
        tier: 1, kind: 'kill', target: p.project, pid: p.pid, reclaimMb: p.rssMb,
        reason: `${p.type} pid ${p.pid} — its project ${p.project} no longer exists`,
        cmd: ['kill', '-TERM', String(p.pid)],
      });
    }
  }
  for (const wt of s.worktrees) {
    if (wt.prunable || !wt.exists) {
      add({
        tier: 1, kind: 'prune-worktree', target: wt.path, repo: wt.repo, reclaimMb: wt.cacheMb,
        reason: 'git reports this worktree as prunable (its directory is gone)',
        cmd: ['git', '-C', wt.repo, 'worktree', 'prune'],
      });
    }
  }
  for (const proj of s.projects) {
    if (proj.exists) continue;
    for (const a of proj.artifacts) {
      if (a.tracked) continue;
      add({
        tier: 1, kind: 'rm-artifact', target: a.path, reclaimMb: a.sizeMb,
        reason: `${a.tool} ${a.category} for a project that no longer exists`,
        cmd: ['rm', '-rf', a.path],
      });
    }
  }

  // ── tier 2: idle ────────────────────────────────────────────────────────────
  const idleSec = cfg.idleDaemonMinutes * 60;
  // A dev server or test runner is classified as work, and work was never a cleanup
  // candidate at any tier: the only kill path is tier 1, which fires solely when the
  // project directory is gone. So a `next dev` left running for a week in a repo that
  // still exists was unreachable by every tier. Age is what separates work in flight
  // from work someone walked away from.
  for (const p of s.processes) {
    if (p.type === 'claude' || !p.project || !isReapable(p.type)) continue;
    if (p.ageSec < abandonedSec) continue;
    if (actions.some((a) => a.pid === p.pid)) continue;
    // Age alone is not enough for a helper: a long-lived esbuild or swc process inside a
    // project that is genuinely busy is serving that work. A server gets no such pass —
    // four days idle is abandoned whatever else the repo is doing.
    if (!isServer(p) && s.projects.find((x) => x.root === p.project)?.active) continue;
    // Dev servers sit under a pnpm/npm wrapper shell; killing only the leaf orphans it.
    const kids = s.processes.filter((k) => k.ppid === p.pid);
    const pids = [p.pid, ...kids.map((k) => k.pid)];
    add({
      tier: 2, kind: 'kill', target: p.project, pid: p.pid,
      reclaimMb: p.rssMb + kids.reduce((n, k) => n + k.rssMb, 0),
      reason: `${p.type} pid ${p.pid} running ${Math.round(p.ageSec / 3600)}h — abandoned, not in flight; restart it when you need it`,
      cmd: ['kill', '-TERM', ...pids.map(String)],
    });
  }
  for (const p of s.processes) {
    if (!isDaemon(p.type) || !p.project) continue;
    const proj = s.projects.find((x) => x.root === p.project);
    if (proj?.active || p.ageSec < 300) continue;
    const oldest = proj?.artifacts.reduce((m, a) => Math.min(m, a.lastWriteSec ?? Infinity), Infinity) ?? Infinity;
    if (oldest < idleSec) continue;
    const kids = s.processes.filter((k) => k.ppid === p.pid);
    add({
      tier: 2, kind: 'stop-daemon', target: p.project, pid: p.pid,
      reclaimMb: p.rssMb + kids.reduce((n, k) => n + k.rssMb, 0),
      reason: `${p.type} idle ${Math.round(oldest / 60)}m with no running task (${kids.length} worker${kids.length === 1 ? '' : 's'}); restarts on demand`,
      cmd: p.type === 'nx-daemon'
        ? ['npx', '--no-install', 'nx', 'reset', '--only-daemon']
        : ['kill', '-TERM', String(p.pid)],
      cwd: p.type === 'nx-daemon' ? p.project : undefined,
    });
  }
  // Staleness used to be the repo's commit recency, which says nothing about whether a
  // build directory is cold: a monorepo you commit to daily kept a target/ nobody had
  // compiled in months pinned in tier 3. What the artifact's own mtime says is the thing
  // we actually mean, and it is also the safety check — anything a build is currently
  // writing to has a recent mtime and is excluded on that basis, so a live build no
  // longer needs a separate process guard.
  for (const proj of s.projects) {
    if (!proj.exists || proj.active) continue;
    for (const a of proj.artifacts) {
      if (a.sizeMb <= 0 || a.tracked) continue;
      if ((a.lastWriteSec ?? 0) < staleSec) continue;
      add({
        tier: 2, kind: 'rm-artifact', target: a.path, reclaimMb: a.sizeMb,
        reason: `${a.tool} ${a.category} in ${proj.name}, untouched ${Math.round((a.lastWriteSec ?? 0) / 86400)}d, nothing building against it`,
        cmd: ['rm', '-rf', a.path],
      });
    }
  }
  // A worktree whose branch is fully merged into the default branch, with a clean working
  // tree and nothing running in it, holds no unique state — every commit is already on the
  // mainline and nothing is uncommitted. Removing it is recoverable, so it belongs here
  // rather than in tier 3.
  for (const wt of s.worktrees) {
    if (!wt.exists || wt.prunable || wt.isPrimary || wt.locked) continue;
    if (!wt.merged || wt.dirty !== false || wt.hasProcess) continue;
    if ((wt.ageDays ?? 0) < cfg.staleWorktreeDays) continue;
    add({
      tier: 2, kind: 'remove-worktree', target: wt.path, repo: wt.repo, reclaimMb: wt.cacheMb,
      reason: `${wt.branch} is fully merged into ${wt.baseBranch}, working tree is clean, nothing running — ${Math.round(wt.ageDays)}d old`,
      cmd: ['git', '-C', wt.repo, 'worktree', 'remove', wt.path],
    });
  }

  for (const st of s.stores) {
    if (!st.prune || !st.safe) continue;
    if (st.sizeMb / 1024 < cfg.thresholds.storeGb) continue;
    add({
      tier: 2, kind: 'prune-store', target: st.path, reclaimMb: Math.round(st.sizeMb * 0.3),
      reason: `${st.name} is ${(st.sizeMb / 1024).toFixed(1)}GB; prune removes only unreferenced entries`,
      cmd: st.prune,
    });
  }

  // ── tier 3: live ────────────────────────────────────────────────────────────
  for (const p of s.processes) {
    if (!isDaemon(p.type) || !p.project || actions.some((a) => a.pid === p.pid)) continue;
    const proj = s.projects.find((x) => x.root === p.project);
    const kids = s.processes.filter((k) => k.ppid === p.pid);
    add({
      tier: 3, kind: 'stop-daemon', target: p.project, pid: p.pid,
      reclaimMb: p.rssMb + kids.reduce((n, k) => n + k.rssMb, 0),
      reason: proj?.active
        ? `${p.type} for ${proj.name} — WORK IN FLIGHT; stopping this interrupts a running task`
        : `${p.type} for ${proj?.name ?? p.project} — recently active`,
      cmd: p.type === 'nx-daemon'
        ? ['npx', '--no-install', 'nx', 'reset', '--only-daemon']
        : ['kill', '-TERM', String(p.pid)],
      cwd: p.type === 'nx-daemon' ? p.project : undefined,
    });
  }
  // Build output in a project that is still active is regenerable but not stale, so tier 2
  // will not touch it. It is often the largest thing on the disk, so surface it here as an
  // explicit choice rather than leaving it invisible.
  for (const proj of s.projects) {
    if (!proj.exists) continue;
    for (const a of proj.artifacts) {
      if (a.category !== 'output' || a.sizeMb <= 0 || a.tracked) continue;
      if (actions.some((x) => x.target === a.path)) continue;
      add({
        tier: 3, kind: 'rm-artifact', target: a.path, reclaimMb: a.sizeMb,
        blocked: proj.active ? 'building' : null,
        reason: proj.active
          ? `${a.tool} output in ${proj.name} — a build is running against this right now`
          : `${a.tool} output in ${proj.name}, last written ${Math.round((a.lastWriteSec ?? 0) / 86400)}d ago — regenerable, but costs a full rebuild`,
        cmd: ['rm', '-rf', a.path],
      });
    }
  }

  // An artifact with no project marker above it used to be tier 1, "provably dead". It is
  // nothing of the kind: chaff simply cannot tell who owns it. A plain npm project with no
  // .git, a project deeper than maxScanDepth, a sibling folder under an inferred root — all
  // land here, and their dist/ or build/ may be the only copy of something. Surface it for
  // a person to judge; never act on it automatically or over MCP.
  for (const a of s.orphanArtifacts) {
    if (a.sizeMb <= 0 || a.tracked) continue;
    add({
      tier: 3, kind: 'rm-artifact', target: a.path, reclaimMb: a.sizeMb,
      reason: `${a.tool} ${a.category} under no project chaff recognises — check what owns it before removing`,
      cmd: ['rm', '-rf', a.path],
    });
  }

  for (const st of s.stores) {
    if (st.safe) continue;
    add({
      tier: 3, kind: 'rm-store', target: st.path, reclaimMb: st.sizeMb,
      reason: `${st.name} is ${(st.sizeMb / 1024).toFixed(1)}GB — deleting means re-downloading browser binaries`,
      cmd: ['rm', '-rf', st.path],
    });
  }
  for (const wt of s.worktrees) {
    if (!wt.exists || wt.prunable || wt.isPrimary) continue;
    if ((wt.ageDays ?? 0) < cfg.staleWorktreeDays) continue;
    if (actions.some((a) => a.kind === 'remove-worktree' && a.target === wt.path)) continue;
    const age = Math.round(wt.ageDays);
    add({
      tier: 3, kind: 'remove-worktree', target: wt.path, repo: wt.repo, reclaimMb: wt.cacheMb,
      blocked: wt.locked ? 'locked' : wt.hasProcess ? 'in use' : wt.dirty === true ? 'uncommitted' : null,
      reason: wt.locked ? `${age}d stale, but LOCKED — unlock it first`
        : wt.hasProcess ? `${age}d stale, but a process is running in it`
        : wt.dirty === true ? `${age}d stale on ${wt.branch || 'detached HEAD'} — HAS UNCOMMITTED CHANGES, commit or stash first`
        : !wt.merged ? `${age}d stale on ${wt.branch || 'detached HEAD'} — NOT merged into ${wt.baseBranch}; its commits exist nowhere else`
        : `${age}d stale on ${wt.branch || 'detached HEAD'}`,
      cmd: ['git', '-C', wt.repo, 'worktree', 'remove', wt.path],
    });
  }

  const t = cfg.thresholds, breached = [];
  if (s.totals.nodeRssMb > t.nodeRssMb) breached.push(`toolchain RSS ${(s.totals.nodeRssMb / 1024).toFixed(1)}GB > ${(t.nodeRssMb / 1024).toFixed(1)}GB`);
  if (s.totals.daemons > t.daemons) breached.push(`${s.totals.daemons} daemons > ${t.daemons}`);
  if (s.disk.freeGb < t.diskFreeGb) breached.push(`${s.disk.freeGb}GB free < ${t.diskFreeGb}GB`);
  if (s.totals.cacheMb / 1024 > t.cacheGb) breached.push(`${(s.totals.cacheMb / 1024).toFixed(1)}GB of build cache > ${t.cacheGb}GB`);
  if (s.totals.worktrees > t.worktrees) breached.push(`${s.totals.worktrees} worktrees > ${t.worktrees}`);
  if (s.totals.storeMb / 1024 > t.storeGb) breached.push(`${(s.totals.storeMb / 1024).toFixed(1)}GB of package stores > ${t.storeGb}GB`);

  actions.sort((a, b) => a.tier - b.tier || b.reclaimMb - a.reclaimMb);
  const sum = (tier) => actions.filter((a) => a.tier === tier).reduce((n, a) => n + a.reclaimMb, 0);
  return {
    scannedAt: s.scannedAt, policy: cfg.policy, breached, actions,
    reclaimable: { tier1Mb: sum(1), tier2Mb: sum(2), tier3Mb: sum(3) },
  };
}

// ── apply ─────────────────────────────────────────────────────────────────────

const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Block without spinning, in a synchronous context. */
const waitMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * `kill` exits 0 once the signal is delivered, which says nothing about whether the process
 * acted on it — dev servers under a package-manager wrapper routinely ignore SIGTERM and
 * stay up, and reporting those as "done" is how a cleanup silently accomplishes nothing.
 * Wait for the exit, escalate once, and report what actually happened.
 */
/**
 * True when `pid` is still running `expected`. ps may truncate a long command differently
 * between calls, so a prefix match either way counts; an empty reading never does.
 */
export function sameProcess(pid, expected, read = procCommand) {
  if (!expected) return false;
  const now = read(pid);
  if (!now) return false;
  return now === expected || now.startsWith(expected) || expected.startsWith(now);
}

function procCommand(pid) {
  return run('ps', ['-o', 'command=', '-p', String(pid)]).trim();
}

function confirmDead(pids, graceMs = 2000) {
  const alive = () => pids.filter((p) => processAlive(p));
  for (const deadline = Date.now() + graceMs; Date.now() < deadline && alive().length; ) waitMs(100);
  const survivors = alive();
  if (!survivors.length) return { ok: true, escalated: false };
  try { execFileSync('kill', ['-KILL', ...survivors.map(String)], { stdio: 'ignore' }); } catch { /* raced */ }
  for (const deadline = Date.now() + 1000; Date.now() < deadline && alive().length; ) waitMs(100);
  return { ok: alive().length === 0, escalated: true, stubborn: alive() };
}

export function applyPlan(plan, { maxTier, dryRun, useTrash = false }) {
  const results = [];
  for (const a of plan.actions) {
    if (a.tier > maxTier) continue;
    if (a.blocked) { results.push({ ...a, status: 'skipped', note: a.blocked }); continue; }
    if (dryRun) { results.push({ ...a, status: 'dry-run' }); continue; }
    // Re-verify immediately before acting: a plan built seconds ago may already be stale.
    if (a.pid && !processAlive(a.pid)) { results.push({ ...a, status: 'skipped', note: 'process already gone' }); continue; }
    // …and a live pid may no longer be the process that was planned. Signal only the pids
    // whose command still matches; skip the action outright if the main one does not.
    let cmdLine = a.cmd;
    if (a.cmd[0] === 'kill' && a.expect) {
      const same = (pid) => sameProcess(pid, a.expect[pid]);
      if (a.pid && !same(String(a.pid))) {
        results.push({ ...a, status: 'skipped', note: `pid ${a.pid} now belongs to a different process` }); continue;
      }
      cmdLine = a.cmd.filter((x) => !/^\d+$/.test(x) || same(x));
    }
    if ((a.kind === 'rm-artifact' || a.kind === 'rm-store') && !existsSync(a.target)) {
      results.push({ ...a, status: 'skipped', note: 'already gone' }); continue;
    }

    // Deletions go to the trash when enabled, so a mistake is a rename away from undone.
    if (useTrash && (a.kind === 'rm-artifact' || a.kind === 'rm-store')) {
      try {
        const dest = trashPath(a.target);
        if (dest) { results.push({ ...a, status: 'done', note: 'trashed', trash: dest }); continue; }
        // Different filesystem: fall through to a real delete rather than copy 20GB.
      } catch (e) {
        results.push({ ...a, status: 'failed', note: e.message.split('\n')[0] }); continue;
      }
    }

    const [cmd, ...args] = cmdLine;
    try {
      execFileSync(cmd, args, { stdio: 'ignore', cwd: a.cwd || process.cwd(), timeout: 180_000 });
      if (cmd === 'kill') {
        const pids = args.filter((x) => /^\d+$/.test(x)).map(Number);
        const r = confirmDead(pids);
        if (!r.ok) {
          results.push({ ...a, status: 'failed', note: `still alive after SIGKILL: ${r.stubborn.join(', ')}` });
          continue;
        }
        results.push({ ...a, status: 'done', note: r.escalated ? 'ignored SIGTERM; SIGKILL sent' : undefined });
        continue;
      }
      results.push({ ...a, status: 'done' });
    } catch (e) {
      results.push({ ...a, status: 'failed', note: e.message.split('\n')[0] });
    }
  }
  return results;
}

// ── rendering ─────────────────────────────────────────────────────────────────

const gb = (mb) => (mb / 1024).toFixed(1);
const bar = (pct, w = 20) => {
  const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return '█'.repeat(n) + '░'.repeat(w - n);
};

/** Terminal width, with a conservative default: piped output reports nothing. */
const termWidth = (override) => +override || process.stdout.columns || +process.env.COLUMNS || 80;

const useColor = (cfg) => !process.env.NO_COLOR && (cfg.statuslineStyle || 'color') !== 'plain';
const paint = (cfg, bad, text) => (useColor(cfg) ? `${bad ? ANSI.red : ANSI.green}${text}${ANSI.off}` : text);

/**
 * One description of the five headline metrics, shared by the tile row and the legend.
 * `2d` and `50wt` are unreadable without it — the abbreviations only make sense to someone
 * who already knows what chaff measures, which is nobody on their first day.
 */
function metrics(s, cfg) {
  const t = cfg.thresholds;
  const junkMb = s.totals.cacheMb + s.totals.outputMb;
  return [
    { label: 'TOOLCHAIN MEM', value: `${gb(s.totals.nodeRssMb)}G/${s.totals.nodeProcs}p`,
      sub: `across ${s.totals.nodeProcs} procs`, bad: s.totals.nodeRssMb > t.nodeRssMb,
      means: 'build-tool memory: node, JVM, Unity, cargo, python',
      limit: `> ${gb(t.nodeRssMb)}G`, now: `${gb(s.totals.nodeRssMb)}GB / ${s.totals.nodeProcs}p` },
    { label: 'DAEMONS', value: `${s.totals.daemons}d`,
      sub: `limit ${t.daemons}`, bad: s.totals.daemons > t.daemons,
      means: 'long-lived servers: nx, turbo, tsserver, watchman, LSPs',
      limit: `> ${t.daemons}`, now: `${s.totals.daemons}` },
    { label: 'DISK FREE', value: `${s.disk.freeGb}G`,
      sub: `floor ${t.diskFreeGb}G`, bad: s.disk.freeGb < t.diskFreeGb,
      means: 'free space on the volume holding your first root',
      limit: `< ${t.diskFreeGb}G`, now: `${s.disk.freeGb}GB of ${s.disk.totalGb}GB` },
    { label: 'JUNK', value: `${gb(junkMb)}G`,
      sub: 'cache + output', bad: junkMb / 1024 > t.cacheGb,
      means: 'regenerable build cache and output — excludes node_modules',
      limit: `> ${t.cacheGb}G`, now: `${gb(junkMb)}GB` },
    { label: 'WORKTREES', value: `${s.totals.worktrees}wt`,
      sub: `limit ${t.worktrees}`, bad: s.totals.worktrees > t.worktrees,
      means: 'git worktrees checked out across every scanned project',
      limit: `> ${t.worktrees}`, now: `${s.totals.worktrees}` },
  ];
}

/** Tile row. Only rendered when the terminal is wide enough to hold it without wrapping. */
export function renderTiles(s, cfg, width) {
  const m = metrics(s, cfg);
  const w = Math.max(14, Math.floor((width - 4) / m.length));
  const pad = (txt, len) => txt + ' '.repeat(Math.max(0, len - txt.length));
  const line = (fn) => '  ' + m.map((x) => pad(fn(x), w)).join('').trimEnd();
  return [
    '  ' + '─'.repeat(Math.min(width - 4, 100)),
    line((x) => x.label),
    // padded before painting: ANSI codes have width on the string but none on screen
    '  ' + m.map((x) => paint(cfg, x.bad, pad(x.value, w))).join('').trimEnd(),
    line((x) => x.sub),
    '  ' + '─'.repeat(Math.min(width - 4, 100)),
  ];
}

const fit = (txt, n) => (txt.length <= n ? txt.padEnd(n) : txt.slice(0, n - 1) + '…');

const wrap = (txt, n) => txt.split(' ').reduce((lines, w) => {
  const last = lines[lines.length - 1];
  if (last && (last + ' ' + w).length <= n) lines[lines.length - 1] = last + ' ' + w;
  else lines.push(w);
  return lines;
}, []);

/**
 * The legend: what each abbreviation means, what trips it, and where it stands now.
 * Falls back to a stacked block per metric on a narrow terminal — a five-column table
 * that wraps is harder to read than no table at all.
 */
export function renderExplain(s, cfg, width = termWidth()) {
  const m = metrics(s, cfg);
  const L = [''];
  if (width >= 100) {
    const C = [['METRIC', 15], ['WHAT IT MEANS', Math.min(58, width - 56)], ['TRIPS AT', 9], ['NOW', 19], ['STATE', 5]];
    L.push('  ' + C.map(([h, w]) => fit(h, w)).join(' '));
    L.push('  ' + '─'.repeat(C.reduce((a, c) => a + c[1] + 1, 0) - 1));
    for (const x of m) {
      L.push('  ' + [fit(x.label, C[0][1]), fit(x.means, C[1][1]), fit(x.limit, C[2][1]), fit(x.now, C[3][1])]
        .join(' ') + paint(cfg, x.bad, x.bad ? 'over' : 'ok'));
    }
  } else {
    for (const x of m) {
      L.push(`  ${x.label}  ${paint(cfg, x.bad, x.bad ? 'over' : 'ok')}  ·  now ${x.now}  ·  trips at ${x.limit}`);
      for (const line of wrap(x.means, width - 6)) L.push('      ' + line);
      L.push('');
    }
  }
  L.push('');
  L.push('  the statusline reads left to right in this order. a metric with nothing to');
  L.push('  report (no daemons, no worktrees) is left out rather than shown as zero.');
  L.push('');
  return L.join('\n');
}

function renderScan(s, cfg, { width = termWidth(), explain = false } = {}) {
  const t = cfg.thresholds, L = [''];
  L.push(`  chaff  ·  ${s.roots.length ? s.roots.join('  ') : 'no project scan'}`);
  if (s.rootsRefused) {
    L.push(`  scope         ${s.rootsRefused.replace(HOME, '~')} is at or above home — projects, artifacts and`);
    L.push('                worktrees were not scanned.  set roots:  /chaff:config roots=["~/code"]');
  } else if (s.rootsInferred) {
    L.push(`  scope         inferred from cwd — set explicitly:  /chaff:config roots=${JSON.stringify(s.roots.map((r) => r.replace(HOME, '~')))}`);
  }
  // Tiles need ~100 columns; below that the bars below say the same thing in less space.
  if (width >= 100) L.push(...renderTiles(s, cfg, width));
  else L.push('  ' + '─'.repeat(76));
  L.push(`  toolchain mem ${bar(Math.min(100, (s.totals.nodeRssMb / t.nodeRssMb) * 100))}  ${gb(s.totals.nodeRssMb)}GB across ${s.totals.nodeProcs} processes  (limit ${gb(t.nodeRssMb)}GB)`);
  L.push(`  disk          ${bar(s.disk.pctUsed)}  ${s.disk.freeGb}GB free of ${s.disk.totalGb}GB        (floor ${t.diskFreeGb}GB)`);
  L.push(`  build cache   ${bar(Math.min(100, (s.totals.cacheMb / 1024 / t.cacheGb) * 100))}  ${gb(s.totals.cacheMb)}GB   build output ${gb(s.totals.outputMb)}GB   stores ${gb(s.totals.storeMb)}GB`);
  if (s.totals.depsMb != null) {
    const age = s.totals.depsAgeSec > 60 ? `  (measured ${Math.round(s.totals.depsAgeSec / 3600)}h ago)` : '';
    L.push(`  node_modules  ${bar(100)}  ${gb(s.totals.depsMb)}GB across ${s.projects.filter((p) => p.nodeModulesMb).length} installs${age}`);
  } else {
    L.push(`  node_modules  —  not measured (run with --full; usually the largest item on disk)`);
  }
  L.push(`  daemons ${s.totals.daemons}${s.totals.daemons > t.daemons ? ' ⚠' : ''}    projects ${s.totals.projects}    worktrees ${s.totals.worktrees}${s.totals.worktrees > t.worktrees ? ' ⚠' : ''}    claude sessions ${s.totals.claudeProcs}`);
  L.push('');

  const rows = s.projects.filter((p) => p.procCount || p.cacheMb || p.outputMb)
    .sort((a, b) => b.rssMb - a.rssMb || (b.cacheMb + b.outputMb) - (a.cacheMb + a.outputMb));
  const mb = (n) => (n ? (n >= 1024 ? (n / 1024).toFixed(1) + 'G' : n + 'M') : '·');
  const COLS = [['PROJECT', 42, 'l'], ['KIND', 7, 'l'], ['CACHE', 7, 'r'], ['OUTPUT', 8, 'r'],
                ['PROCS', 6, 'r'], ['RSS', 7, 'r'], ['STATE', 7, 'l']];
  const row = (cells) => '  ' + cells
    .map((c, i) => (COLS[i][2] === 'r' ? String(c).padStart(COLS[i][1]) : String(c).padEnd(COLS[i][1])))
    .join(' ');
  L.push(row(COLS.map((c) => c[0])));
  for (const p of rows.slice(0, 24)) {
    const label = p.root.replace(HOME, '~').replace(/\/\.claude\/worktrees\//, '/wt:');
    L.push(row([
      label.length > 42 ? '…' + label.slice(-41) : label,
      p.kinds.filter((k) => k !== 'git').join(',').slice(0, 7) || 'git',
      mb(p.cacheMb), mb(p.outputMb), p.procCount || '·', mb(p.rssMb),
      !p.exists ? 'GONE' : p.active ? 'active' : p.daemons.length ? 'daemon' : 'cold',
    ]));
  }
  if (rows.length > 24) L.push(`  … and ${rows.length - 24} more`);
  if (s.stores.length) {
    L.push('');
    L.push('  SHARED STORES');
    for (const st of s.stores) L.push(`  ${st.name.padEnd(24)} ${(gb(st.sizeMb) + 'GB').padStart(8)}${st.safe ? '' : '  (not auto-prunable)'}  ${st.path.replace(HOME, '~')}`);
  }
  if (explain) L.push(renderExplain(s, cfg, width));
  L.push('');
  return L.join('\n');
}

function renderPlan(plan) {
  const TIER = {
    1: ['TIER 1 — DEAD', 'provably safe: what this belongs to no longer exists'],
    2: ['TIER 2 — IDLE', 'safe, but costs a cold rebuild or a re-download'],
    3: ['TIER 3 — LIVE', 'touches running work or uncommitted code — never automatic'],
  };
  const L = [''];
  if (plan.breached.length) {
    L.push('  ⚠ thresholds breached:');
    for (const b of plan.breached) L.push(`      · ${b}`);
    L.push('');
  }
  for (const tier of [1, 2, 3]) {
    const as = plan.actions.filter((a) => a.tier === tier);
    if (!as.length) continue;
    L.push(`  ${TIER[tier][0]}  ·  ${as.length} action${as.length === 1 ? '' : 's'}  ·  ~${gb(as.reduce((n, a) => n + a.reclaimMb, 0))}GB`);
    L.push(`  ${TIER[tier][1]}`);
    for (const a of as.slice(0, 30)) {
      L.push(`      ${a.kind.padEnd(16)}${(gb(a.reclaimMb) + 'GB').padStart(8)}  ${a.target.replace(HOME, '~')}${a.blocked ? `  [${a.blocked}]` : ''}`);
      L.push(`      ${' '.repeat(16)}          ↳ ${a.reason}`);
    }
    if (as.length > 30) L.push(`      … and ${as.length - 30} more`);
    L.push('');
  }
  if (!plan.actions.length) L.push('  Nothing to separate. Everything here is live.\n');
  const r = plan.reclaimable;
  L.push(`  reclaimable:  tier1 ${gb(r.tier1Mb)}GB   tier1+2 ${gb(r.tier1Mb + r.tier2Mb)}GB   all tiers ${gb(r.tier1Mb + r.tier2Mb + r.tier3Mb)}GB`);
  L.push(`  policy: ${plan.policy}`);
  L.push('');
  return L.join('\n');
}

const ANSI = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };

/**
 * Three ways to mark a breach, because a statusline is personal: `color` tints the metric
 * itself, `dots` keeps the emoji, `plain` marks nothing. NO_COLOR downgrades color to plain.
 */
export function renderStatusline(s, cfg) {
  const t = cfg.thresholds;
  const style = process.env.NO_COLOR && cfg.statuslineStyle === 'color' ? 'plain' : (cfg.statuslineStyle || 'color');
  const mark = (bad, text) => {
    if (style === 'dots') return `${bad ? '🔴' : '🟢'} ${text}`;
    if (style === 'color') return `${bad ? ANSI.red : ANSI.green}${text}${ANSI.off}`;
    return text;
  };
  // An inferred scope is flagged here too: the junk/worktree counts are only as complete
  // as the roots behind them, and this line is where most people read them.
  const scopeText = s.rootsRefused ? '⚠ no roots' : s.rootsInferred ? '⚠ cwd' : '';
  const scope = !scopeText ? ''
    : ' ' + (style === 'color' ? `${ANSI.yellow}${scopeText}${ANSI.off}` : scopeText);
  const junkMb = s.totals.cacheMb + s.totals.outputMb;
  // Counts of things a machine may simply not have — no daemons running, no worktrees
  // checked out — are dropped rather than shown as a green zero. A permanent `0d` on a
  // Rust or Python codebase is noise pretending to be a metric. Memory, disk and junk
  // always render: zero there is a real reading, not an absent concept.
  const segs = [
    [true, s.totals.nodeRssMb > t.nodeRssMb, `${gb(s.totals.nodeRssMb)}G/${s.totals.nodeProcs}p`],
    [s.totals.daemons > 0, s.totals.daemons > t.daemons, `${s.totals.daemons}d`],
    [true, s.disk.freeGb < t.diskFreeGb, `${s.disk.freeGb}G free`],
    [true, junkMb / 1024 > t.cacheGb, `${gb(junkMb)}G junk`],
    [s.totals.worktrees > 0, s.totals.worktrees > t.worktrees, `${s.totals.worktrees}wt`],
  ];
  return 'chaff' + scope + ' ' + segs.filter(([show]) => show).map(([, bad, text]) => mark(bad, text))
    .join(style === 'color' ? `${ANSI.dim} · ${ANSI.off}` : ' · ');
}

// ── scan cache ────────────────────────────────────────────────────────────────

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    return c.schema === 2 ? c : null;
  } catch { return null; }
}

function writeCache(s) {
  try { mkdirSync(CHAFF_HOME, { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(s)); }
  catch { /* best effort */ }
}

function cachedScan(cfg, opts) {
  const c = readCache();
  if (c && (Date.now() - new Date(c.scannedAt).getTime()) / 1000 < cfg.scanTtlSeconds) return c;
  const fresh = scan(cfg, opts);
  if (fresh) { writeCache(fresh); return fresh; }
  // Another scan holds the lock. Serve whatever we have rather than starting a second one.
  if (c) return c;
  process.stderr.write('chaff: a scan is already running; try again in a moment\n');
  process.exit(3);
}


const HELP = `
  chaff — separate the live work from the dead weight on a developer machine

  SEEING WHAT IS THERE                                              (never changes anything)
    chaff status                  live pressure + per-project breakdown
    chaff plan                    what it would clean, sorted by safety tier
    chaff statusline              one-line summary for your editor statusline
    chaff top                     processes by memory, attributed to a project
    chaff doctor                  what is wrong and what to do about it
    chaff worktrees [--dirty]     every worktree, with what is uncommitted in it

  RECLAIMING SPACE
    chaff reap                    tier 1 only — provably dead. Safe, no prompt.
    chaff clean --tier=2 --yes    + idle daemons, stale caches, stale build output
    chaff clean --tier=3 --yes --force
                                  + live daemons, active build output, stale worktrees

  SEEING FIRST, THEN ACTING
    chaff clean --tier=2 --dry-run    print the exact list, change nothing

  CONFIG
    chaff config                          show current settings
    chaff config --set=policy=propose     propose | auto-orphans | auto-threshold
    chaff config --set=roots=["~/Work"]   directories to scan

  UNATTENDED
    chaff schedule                        show nightly-cleanup status
    chaff schedule --install --hour=3     run tier 2 nightly at 03:00
    chaff schedule --uninstall            stop it

  CI RUNNERS
    chaff ci                      clean tier 2, print a one-line report, exit 0
    chaff ci --strict             exit 1 when still below the disk floor
    chaff ci --json --tier=1      machine-readable, provably-dead only

  AGENTS (MCP)
    chaff mcp                     serve over stdio for Codex, Cursor, Zed, Claude Code
                                  read-only tools plus tier 1-2 cleanup; tier 3 is CLI-only

  UNDO
    chaff trash                   what was removed and can still be restored
    chaff restore <id>            put one back
    chaff trash --empty           purge now (otherwise auto-purged after trashTtlDays)

  TIERS
    1  dead   the project/worktree/process it belongs to is gone.  Costs you nothing.
    2  idle   nothing running, nothing touched it recently.        Costs a cold rebuild.
    3  live   running tasks, active builds, uncommitted work.      Costs real work.
              Entries marked [locked] [in use] [building] are never executed, even --force.

  FLAGS
    --json        machine-readable      --fresh     bypass the 20s scan cache
    --dry-run     show, do not act      --deep      also size node_modules
    --tier=N      how far to go         --yes       required for tier 2
    --full        include node_modules  --dirty     worktrees: only unclean ones
    --force       required for tier 3   --stale=N   statusline rescan window (seconds)
    --plain       statusline: no ANSI, for tmux / starship / a bare prompt
    --explain     append a legend to status: what each metric means and what trips it

  ECOSYSTEMS
    JS/TS     nx turbo next vite angular parcel rollup rspack webpack expo storybook
    Rust      target/ (gated on Cargo.toml), cargo registry
    .NET      obj/ (gated on *.csproj/*.sln), nuget packages
    Go        module cache, build cache
    JVM       .gradle/, target/ (gated on pom.xml), gradle + maven caches
    Python    __pycache__ .pytest_cache .mypy_cache .ruff_cache .tox, pip cache
    Unity     Library/ Temp/          (gated on ProjectSettings + Assets)
    Unreal    Intermediate/ DerivedDataCache/ Binaries/  (gated on *.uproject)

  In Claude Code:  /chaff:status  /chaff:plan  /chaff:clean  /chaff:reap  /chaff:config
`;

// ── top: processes by memory, attributed to their project ─────────────────────

function renderTop(s, limit) {
  const procs = s.processes
    .filter((p) => p.type !== 'other')
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, limit);
  const L = ['', `  chaff top  ·  ${s.totals.nodeProcs} processes  ·  ${gb(s.totals.nodeRssMb)}GB`, '  ' + '─'.repeat(76)];
  L.push('     PID   RSS    CPU   AGE  TYPE          PROJECT');
  for (const p of procs) {
    const age = p.ageSec > 3600 ? `${Math.round(p.ageSec / 3600)}h` : `${Math.round(p.ageSec / 60)}m`;
    L.push(`  ${String(p.pid).padStart(6)} ${(p.rssMb + 'M').padStart(6)} ${(p.cpu.toFixed(0) + '%').padStart(5)} ${age.padStart(5)}  ${p.type.padEnd(13)} ${(p.project || '—').replace(HOME, '~')}`);
  }
  // Roll up by project so the real cost centre is obvious.
  const byProj = {};
  for (const p of s.processes) {
    if (p.type === 'claude' || !p.project) continue;
    byProj[p.project] = (byProj[p.project] || 0) + p.rssMb;
  }
  const top = Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) {
    L.push('', '  BY PROJECT');
    for (const [proj, mb] of top) L.push(`  ${(gb(mb) + 'GB').padStart(8)}  ${proj.replace(HOME, '~')}`);
  }
  L.push('');
  return L.join('\n');
}

// ── doctor: why is this machine slow, and what should I do about it ───────────

function renderDoctor(s, plan, cfg) {
  const t = cfg.thresholds;
  const findings = [];

  const nxProjects = s.projects.filter((p) => p.nxVersion);
  const oldNx = nxProjects.filter((p) => {
    const [maj, min] = p.nxVersion.split('.').map(Number);
    return maj < 22 || (maj === 22 && min < 7);
  });
  if (oldNx.length) {
    const dupCache = s.projects.filter((p) => p.isWorktree && p.cacheMb > 0).reduce((n, p) => n + p.cacheMb, 0);
    findings.push({
      severity: 'high',
      title: `${oldNx.length} project${oldNx.length === 1 ? '' : 's'} on nx below 22.7`,
      detail: `nx 22.7 added worktree-aware caching (one shared cache instead of a full copy per worktree) and cut daemon memory ~7x. Worktree caches currently total ${gb(dupCache)}GB, most of it duplicated.`,
      fix: `Upgrade: ${[...new Set(oldNx.map((p) => `${p.name}@${p.nxVersion}`))].slice(0, 4).join(', ')}`,
    });
  }

  if (s.totals.daemons > t.daemons) {
    findings.push({
      severity: 'medium',
      title: `${s.totals.daemons} build daemons running (limit ${t.daemons})`,
      detail: `Each daemon holds a project graph in memory and watches the filesystem. Idle ones restart on demand at no cost.`,
      fix: 'chaff clean --tier=2 --yes',
    });
  }

  const mergedWt = s.worktrees.filter((w) => w.merged && !w.dirty && !w.hasProcess && !w.isPrimary);
  const dirtyWt = s.worktrees.filter((w) => w.dirty && !w.isPrimary);
  if (s.totals.worktrees > t.worktrees) {
    findings.push({
      severity: 'medium',
      title: `${s.totals.worktrees} git worktrees (limit ${t.worktrees})`,
      detail: `${mergedWt.length} are fully merged with a clean tree — nothing unique in them. ${dirtyWt.length} have uncommitted changes and must not be removed.`,
      fix: mergedWt.length ? 'chaff clean --tier=2 --yes  (removes only the merged, clean ones)' : 'review with chaff plan',
    });
  }

  const biggest = s.projects.flatMap((p) => p.artifacts).sort((a, b) => b.sizeMb - a.sizeMb).slice(0, 3);
  if (biggest.length && biggest[0].sizeMb > 1024) {
    findings.push({
      severity: s.disk.freeGb < t.diskFreeGb ? 'high' : 'low',
      title: `Largest regenerable artifact is ${gb(biggest[0].sizeMb)}GB`,
      detail: biggest.map((b) => `${(gb(b.sizeMb) + 'GB').padStart(7)}  ${b.path.replace(HOME, '~')}`).join('\n'),
      fix: 'chaff clean --tier=3 --yes --force   (rebuilds on next build)',
    });
  }

  // pnpm is supposed to hardlink every package from one content-addressed store, so N
  // checkouts of the same repo should cost barely more than one. When the store is tiny
  // next to the installs it feeds, hardlinking is not happening and the installs are full
  // copies — usually because they sit on a different filesystem from the store.
  const pnpmStore = s.stores.find((st) => st.name === 'pnpm store');
  if (pnpmStore && s.totals.depsMb > 5 * 1024) {
    const ratio = pnpmStore.sizeMb / s.totals.depsMb;
    if (ratio < 0.1) {
      const byName = {};
      for (const p of s.projects) {
        if (!p.nodeModulesMb) continue;
        const stem = p.name.replace(/[-_]?\d+$/, '').replace(/-(next|new|old|wt.*)$/, '');
        (byName[stem] ||= []).push(p);
      }
      const dupes = Object.entries(byName).filter(([, ps]) => ps.length > 1)
        .map(([stem, ps]) => ({ stem, n: ps.length, mb: ps.reduce((n, x) => n + x.nodeModulesMb, 0) }))
        .sort((a, b) => b.mb - a.mb).slice(0, 4);
      findings.push({
        severity: 'high',
        title: `node_modules is ${gb(s.totals.depsMb)}GB but the pnpm store is only ${gb(pnpmStore.sizeMb)}GB — installs are not hardlinked`,
        detail: (dupes.length
          ? dupes.map((d) => `${(gb(d.mb) + 'GB').padStart(7)}  ${d.n} checkouts of "${d.stem}"`).join('\n')
          : 'Every install is a full copy rather than a link into the store.')
          + `\n              With hardlinking these would cost close to one copy each.`,
        fix: 'Check the store is on the same filesystem as your projects: `pnpm store path`, then `pnpm install` to relink.',
      });
    }
  }

  // Cargo gives every checkout its own target/. Across sibling checkouts of one repo that
  // is the same artifacts compiled over and over. CARGO_TARGET_DIR shares one.
  const cargoDirs = s.projects.flatMap((p) => p.artifacts).filter((a) => a.tool === 'cargo/maven' && a.sizeMb > 512);
  if (cargoDirs.length > 1) {
    const bySuffix = {};
    for (const a of cargoDirs) {
      // group by position within the repo, e.g. "apps/agent/src-tauri/target"
      const key = a.path.split(/[\\/]+/).slice(-4).join('/');
      (bySuffix[key] ||= []).push(a);
    }
    const dupes = Object.entries(bySuffix).filter(([, as]) => as.length > 1)
      .map(([key, as]) => ({ key, n: as.length, mb: as.reduce((n, x) => n + x.sizeMb, 0) }))
      .sort((a, b) => b.mb - a.mb);
    const total = cargoDirs.reduce((n, a) => n + a.sizeMb, 0);
    if (total / 1024 > 5) {
      findings.push({
        severity: 'high',
        title: `${gb(total)}GB in Cargo target directories across ${cargoDirs.length} checkouts`,
        detail: (dupes.length
          ? dupes.slice(0, 3).map((d) => `${(gb(d.mb) + 'GB').padStart(7)}  ${d.n}× ${d.key}`).join('\n')
          : cargoDirs.slice(0, 3).map((a) => `${(gb(a.sizeMb) + 'GB').padStart(7)}  ${a.path.replace(HOME, '~')}`).join('\n'))
          + `\n              Sibling checkouts each recompile the same crates into their own target/.`,
        fix: 'Share one: export CARGO_TARGET_DIR=~/.cargo/target  (or install sccache)',
      });
    }
  }

  const bigStores = s.stores.filter((st) => st.sizeMb / 1024 > 1);
  if (bigStores.length) {
    findings.push({
      severity: 'low',
      title: `${gb(s.totals.storeMb)}GB in shared package stores`,
      detail: bigStores.map((st) => `${(gb(st.sizeMb) + 'GB').padStart(7)}  ${st.name}${st.safe ? '' : '  (re-download is expensive)'}`).join('\n'),
      fix: 'chaff clean --tier=2 --yes   (prunes only unreferenced entries)',
    });
  }

  if (s.disk.freeGb < t.diskFreeGb) {
    findings.push({
      severity: 'high',
      title: `${s.disk.freeGb}GB free, below your ${t.diskFreeGb}GB floor`,
      detail: `chaff can reclaim ${gb(plan.reclaimable.tier1Mb + plan.reclaimable.tier2Mb)}GB safely, ${gb(plan.reclaimable.tier1Mb + plan.reclaimable.tier2Mb + plan.reclaimable.tier3Mb)}GB in total.`,
      fix: 'chaff clean --tier=2 --yes',
    });
  }

  // Duplicate installs of the same repo across sibling checkouts.
  const stems = {};
  for (const p of s.projects) {
    if (p.isWorktree || !p.exists) continue;
    const stem = p.name.replace(/[-_]?\d+$/, '').replace(/-(next|new|old|copy)$/, '');
    if (stem !== p.name || (p.nodeModulesMb || 0) > 0) (stems[stem] ||= []).push(p);
  }
  const sibling = Object.entries(stems).filter(([, ps]) => ps.length > 2)
    .map(([stem, ps]) => ({ stem, n: ps.length, mb: ps.reduce((n, x) => n + (x.nodeModulesMb || 0) + x.cacheMb + x.outputMb, 0) }))
    .sort((a, b) => b.mb - a.mb);
  if (sibling.length && sibling[0].n >= 3) {
    findings.push({
      severity: 'medium',
      title: `${sibling[0].n} sibling checkouts of "${sibling[0].stem}" costing ${gb(sibling[0].mb)}GB`,
      detail: sibling.slice(0, 3).map((d) => `${(gb(d.mb) + 'GB').padStart(7)}  ${d.n}× ${d.stem}`).join('\n')
        + '\n              Each carries its own dependencies, caches and build output.',
      fix: 'Consider git worktrees off one checkout instead of full clones, or share caches between them.',
    });
  }

  // A daemon burning CPU with nothing running against it is a known nx failure mode, and
  // it is invisible without something watching for it.
  const runaway = s.processes.filter((p) => p.cpu > 150 && p.ageSec > 600);
  if (runaway.length) {
    findings.push({
      severity: 'high',
      title: `${runaway.length} process${runaway.length === 1 ? '' : 'es'} above 150% CPU for over 10 minutes`,
      detail: runaway.slice(0, 3).map((p) =>
        `${(p.cpu.toFixed(0) + '%').padStart(7)}  ${p.type} pid ${p.pid}, up ${Math.round(p.ageSec / 60)}m  ${(p.project || '?').replace(HOME, '~')}`).join('\n'),
      fix: 'A runaway build daemon. chaff clean --tier=2 --yes, or kill it directly.',
    });
  }

  // Stale trash is reclaimable space people forget they have.
  const tr = trashList();
  if (tr.length) {
    findings.push({
      severity: 'low',
      title: `${tr.length} entr${tr.length === 1 ? 'y' : 'ies'} in chaff's trash`,
      detail: `Removed but still recoverable. Auto-purged after ${cfg.trashTtlDays ?? 7} days.`,
      fix: 'chaff trash    (or chaff trash --empty to reclaim now)',
    });
  }

  const ICON = { high: '🔴', medium: '🟡', low: '⚪' };
  const L = ['', '  chaff doctor', '  ' + '─'.repeat(76)];
  if (!findings.length) { L.push('  Nothing wrong. This machine is in good shape.', ''); return L.join('\n'); }
  findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]));
  for (const f of findings) {
    L.push(`  ${ICON[f.severity]} ${f.title}`);
    L.push(`     ${f.detail.split('\n').join('\n     ')}`);
    L.push(`     → ${f.fix}`);
    L.push('');
  }
  return L.join('\n');
}

// ── worktrees: triage view, including the ones held back as dirty ─────────────

function renderWorktrees(s, cfg, { dirtyOnly = false } = {}) {
  let wts = s.worktrees.filter((w) => !w.isPrimary && w.exists);
  if (dirtyOnly) wts = wts.filter((w) => w.dirty === true || w.dirty === null);
  wts.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const L = ['', `  chaff worktrees  ·  ${wts.length} shown  ·  ${s.worktrees.filter((w) => !w.isPrimary).length} total (excluding primary checkouts)`, '  ' + '─'.repeat(76)];
  if (!wts.length) { L.push('  None.', ''); return L.join('\n'); }

  for (const w of wts) {
    // What is actually uncommitted in here — the thing you need in order to decide.
    let changed = [];
    if (w.dirty !== false) {
      const out = run('git', ['-C', w.path, 'status', '--porcelain'], { timeout: 8_000 });
      changed = out.split('\n').filter(Boolean);
    }
    const age = w.ageDays == null ? '?' : `${Math.round(w.ageDays)}d`;
    const flags = [
      w.merged ? 'merged' : 'UNMERGED',
      w.dirty === true ? `${changed.length} uncommitted` : w.dirty === false ? 'clean' : 'unchecked',
      w.locked ? 'locked' : null,
      w.hasProcess ? 'in use' : null,
    ].filter(Boolean).join(' · ');

    L.push(`  ${age.padStart(4)}  ${(w.branch || 'detached HEAD').slice(0, 50)}`);
    L.push(`        ${w.path.replace(HOME, '~')}`);
    L.push(`        ${flags}`);
    for (const c of changed.slice(0, 6)) L.push(`          ${c}`);
    if (changed.length > 6) L.push(`          … and ${changed.length - 6} more`);
    L.push('');
  }

  const dirty = wts.filter((w) => w.dirty === true);
  if (dirty.length) {
    L.push(`  ${dirty.length} worktree${dirty.length === 1 ? '' : 's'} hold uncommitted work. To keep it, from inside one:`);
    L.push('      git -C <path> stash push -u -m "chaff triage"      # park it on the branch');
    L.push('      git -C <path> add -A && git -C <path> commit -m …  # keep it properly');
    L.push('  Only then is the worktree safe to remove.');
    L.push('');
  }
  return L.join('\n');
}

// ── schedule: unattended nightly cleanup via launchd (macOS) or cron ──────────

const PLIST_LABEL = 'tools.chaff.nightly';
const PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function scheduleArgs(tier) {
  return [process.execPath, process.argv[1], 'clean', `--tier=${tier}`, '--yes', '--fresh'];
}

const LOG_PATH = () => path.join(CHAFF_HOME, 'nightly.log');
const CRON_MARK = '# chaff nightly cleanup';

function scheduleInstall(hour, tier) {
  mkdirSync(CHAFF_HOME, { recursive: true });
  const [exe, ...rest] = scheduleArgs(tier);
  const log = LOG_PATH();

  if (IS_WIN) {
    // schtasks ships with Windows; no extra dependency and no admin rights needed for
    // a per-user daily task.
    const cmdline = `"${exe}" ${rest.map((r) => `"${r}"`).join(' ')}`;
    try {
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/TN', PLIST_LABEL,
        '/ST', `${String(hour).padStart(2, '0')}:00`, '/TR', cmdline],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      return { via: 'schtasks', entry: PLIST_LABEL, log, err: null };
    } catch (e) { return { via: 'schtasks', entry: PLIST_LABEL, log, err: e.stderr?.toString() || e.message }; }
  }

  if (!IS_MAC) {
    // crontab is the one scheduler present on effectively every Linux box.
    const line = `0 ${hour} * * * ${exe} ${rest.join(' ')} >> ${log} 2>&1  ${CRON_MARK}`;
    const current = run('crontab', ['-l']).split('\n').filter((l) => l && !l.includes(CRON_MARK));
    const next = [...current, line].join('\n') + '\n';
    try {
      execFileSync('crontab', ['-'], { input: next, stdio: ['pipe', 'ignore', 'pipe'] });
      return { via: 'cron', entry: line, log, err: null };
    } catch (e) { return { via: 'cron', entry: line, log, err: e.stderr?.toString() || e.message }; }
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[exe, ...rest].map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
  mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist);
  run('launchctl', ['unload', PLIST_PATH]);
  try {
    execFileSync('launchctl', ['load', PLIST_PATH], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    return { via: 'launchd', entry: PLIST_PATH, log, err: null };
  } catch (e) { return { via: 'launchd', entry: PLIST_PATH, log, err: e.stderr || e.message }; }
}

function scheduleStatus() {
  if (IS_WIN) {
    const out = run('schtasks', ['/Query', '/TN', PLIST_LABEL]);
    const found = out.includes(PLIST_LABEL);
    return { via: 'schtasks', installed: found, loaded: found, entry: PLIST_LABEL, log: LOG_PATH() };
  }
  if (!IS_MAC) {
    const line = run('crontab', ['-l']).split('\n').find((l) => l.includes(CRON_MARK));
    return { via: 'cron', installed: !!line, loaded: !!line, entry: line || '(none)', log: LOG_PATH() };
  }
  return {
    via: 'launchd', installed: existsSync(PLIST_PATH),
    loaded: run('launchctl', ['list']).split('\n').some((l) => l.includes(PLIST_LABEL)),
    entry: PLIST_PATH, log: LOG_PATH(),
  };
}

function scheduleRemove() {
  if (IS_WIN) {
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', PLIST_LABEL], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  if (!IS_MAC) {
    const kept = run('crontab', ['-l']).split('\n').filter((l) => l && !l.includes(CRON_MARK));
    try { execFileSync('crontab', ['-'], { input: kept.join('\n') + '\n', stdio: ['pipe', 'ignore', 'ignore'] }); return true; }
    catch { return false; }
  }
  run('launchctl', ['unload', PLIST_PATH]);
  try { unlinkSync(PLIST_PATH); return true; } catch { return false; }
}

// ── cli ───────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'scan';
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
  // `+'all'` is NaN, and every `tier >= 2` guard is false for NaN while `a.tier > NaN` lets
  // every action through — so a typo skipped --yes and --force and ran tier 3. Reject it.
  const tierArg = (d) => {
    const v = val('tier', d);
    if (!/^[123]$/.test(v)) { process.stderr.write(`chaff: --tier must be 1, 2 or 3 (got "${v}")\n`); process.exit(2); }
    return +v;
  };
  // Before anything scans or acts: a bad tier must fail fast, not after a 20s scan.
  if (argv.some((x) => x.startsWith('--tier='))) tierArg('1');
  const cfg = loadConfig();
  const json = flag('json');

  if (sub === 'help' || flag('help') || flag('h')) { process.stdout.write(HELP); return; }

  if (sub === 'config') {
    const set = val('set');
    if (set) {
      const [k, ...rest] = set.split('=');
      const v = rest.join('=');
      const parsed = v === 'true' ? true : v === 'false' ? false
        : /^-?\d+(\.\d+)?$/.test(v) ? +v : v.startsWith('[') ? JSON.parse(v) : v;
      const next = { ...cfg };
      if (k.includes('.')) { const [a, b] = k.split('.'); next[a] = { ...(next[a] || {}), [b]: parsed }; }
      else next[k] = parsed;
      saveConfig(next);
      process.stdout.write(`set ${k} = ${JSON.stringify(parsed)}  (${CONFIG_PATH})\n`);
      return;
    }
    process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
    return;
  }

  if (sub === 'mcp') {
    // Serve MCP over stdio, so Codex, Cursor, Zed and anything else that speaks the protocol
    // gets the same tools. Loading it hands stdin/stdout to the JSON-RPC channel, so nothing
    // else may write to them — no progress, no warnings, no banner.
    import('./mcp.mjs');
    return;
  }

  // Everything past this point needs the POSIX scan layer. help/config/mcp returned above.
  requirePosixScan(sub);

  // Progress goes to stderr and only on a terminal; --json and --quiet suppress it.
  setProgress(cfg.progress !== false && !json && !IS_CI && !flag('quiet'));

  if (sub === 'ci') {
    // One shot for a runner: reclaim what is provably safe, then report. Exits non-zero
    // when the volume is still under the floor, so a pipeline can fail loudly and early
    // rather than halfway through a build.
    // ci deletes outright — no trash, no prompt — which is right on a throwaway runner and
    // wrong on a laptop where someone typed it to see what it does.
    if (!IS_CI && !flag('yes') && !flag('dry-run')) {
      process.stderr.write('chaff ci deletes without the trash and is meant for CI runners (CI is not set).\n'
        + '  Pass --yes to run it here anyway, or --dry-run to see what it would do.\n');
      process.exit(2);
    }
    setProgress(false);
    const scanned = scan(cfg, {}) || readCache();
    if (!scanned) { process.stdout.write('chaff: no scan available\n'); process.exit(3); }
    writeCache(scanned);
    const cplan = buildPlan(scanned, cfg);
    const tier = tierArg('2');
    const results = flag('dry-run') ? [] : applyPlan(cplan, { maxTier: tier, dryRun: false, useTrash: false });
    const freed = results.filter((r) => r.status === 'done').reduce((n, r) => n + r.reclaimMb, 0);
    const after = diskFor(scanned.roots[0] || HOME);
    const report = {
      freedGb: +(freed / 1024).toFixed(2),
      diskFreeGb: after.freeGb, diskPctUsed: after.pctUsed,
      floorGb: cfg.thresholds.diskFreeGb,
      belowFloor: after.freeGb < cfg.thresholds.diskFreeGb,
      actions: results.length,
      cacheGb: +(scanned.totals.cacheMb / 1024).toFixed(2),
      outputGb: +(scanned.totals.outputMb / 1024).toFixed(2),
      projects: scanned.totals.projects, worktrees: scanned.totals.worktrees,
    };
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(
      `chaff: freed ${report.freedGb}GB in ${report.actions} actions · ` +
      `${report.diskFreeGb}GB free (${report.diskPctUsed}% used) · ` +
      `${report.belowFloor ? `BELOW ${report.floorGb}GB floor` : 'ok'}\n`);
    process.exit(report.belowFloor && flag('strict') ? 1 : 0);
  }

  if (sub === 'trash') {
    if (flag('empty')) {
      const n = trashPurge(0);
      process.stdout.write(`  emptied trash (${n} entr${n === 1 ? 'y' : 'ies'})\n`);
      return;
    }
    const entries = trashList();
    if (json) { process.stdout.write(JSON.stringify(entries, null, 2) + '\n'); return; }
    if (!entries.length) { process.stdout.write('  trash is empty\n'); return; }
    process.stdout.write(`\n  ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · purged after ${cfg.trashTtlDays}d\n\n`);
    for (const e of entries) {
      const age = e.ageSec < 3600 ? `${Math.round(e.ageSec / 60)}m` : `${Math.round(e.ageSec / 3600)}h`;
      process.stdout.write(`  ${age.padStart(5)}  ${e.origin.replace(HOME, '~')}\n         id: ${e.id}\n`);
    }
    process.stdout.write(`\n  chaff restore <id>    chaff trash --empty\n\n`);
    return;
  }

  if (sub === 'restore') {
    const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!id) { process.stderr.write('usage: chaff restore <id>   (see: chaff trash)\n'); process.exit(2); }
    const r = trashRestore(id);
    process.stdout.write(r.ok ? `  restored ${r.origin.replace(HOME, '~')}\n` : `  could not restore: ${r.why}\n`);
    process.exit(r.ok ? 0 : 1);
  }

  if (sub === 'schedule') {
    if (flag('uninstall')) {
      process.stdout.write(scheduleRemove() ? '  nightly cleanup removed\n' : '  nothing scheduled\n');
      return;
    }
    if (flag('install')) {
      const hour = +val('hour', '3'), tier = tierArg('2');
      if (tier >= 3) { process.stderr.write('refusing to schedule tier 3: it can delete uncommitted work\n'); process.exit(2); }
      const r = scheduleInstall(hour, tier);
      process.stdout.write(r.err
        ? `  installing via ${r.via} failed: ${String(r.err).trim()}\n  entry: ${r.entry}\n`
        : `  nightly tier-${tier} cleanup scheduled for ${String(hour).padStart(2, '0')}:00 via ${r.via}\n  entry: ${r.entry}\n  log:   ${r.log}\n`);
      return;
    }
    const st = scheduleStatus();
    process.stdout.write(`  scheduler: ${st.via}\n  installed: ${st.installed}\n  loaded:    ${st.loaded}\n  entry:     ${st.entry}\n  log:       ${st.log}\n\n  chaff schedule --install [--hour=3] [--tier=2]\n  chaff schedule --uninstall\n`);
    return;
  }

  if (sub === 'statusline' && (flag('install') || flag('uninstall'))) {
    if (flag('uninstall')) {
      // Off for good: otherwise the plugin's next session start would put it straight back.
      saveConfig({ ...loadConfig(), autoStatusline: false });
      const r = removeStatusline();
      const say = { removed: 'chaff statusline removed', none: 'no statusline was set',
                    foreign: 'your statusline is not chaff\'s; left it alone', error: `could not edit settings: ${r.why}` };
      process.stdout.write(`  ${say[r.status]}\n  automatic setup is off (autoStatusline=false)\n`);
      process.exit(r.status === 'error' ? 1 : 0);
    }
    const self = realpathSync(fileURLToPath(import.meta.url));
    // npx runs from a cache directory that is cleared without notice; a statusline pointing
    // there would break silently some days later.
    if (self.includes(`${path.sep}_npx${path.sep}`)) {
      process.stderr.write('chaff: run this from a global install (npm i -g chaff) or the Claude Code plugin, not npx.\n');
      process.exit(2);
    }
    saveConfig({ ...loadConfig(), autoStatusline: true });
    const r = ensureStatusline(self);
    const say = { installed: 'chaff statusline installed', updated: 'chaff statusline repointed to this install',
                  current: 'chaff statusline already installed', error: `could not edit settings: ${r.why}`,
                  foreign: 'you already have a statusline, so it was left alone. To show chaff under it, add this\n'
                    + `  line to your statusline script:\n\n    ${statuslineCommand(self)}` };
    process.stdout.write(`  ${say[r.status]}\n`);
    process.exit(r.status === 'error' ? 1 : 0);
  }

  if (sub === 'statusline') {
    // Never scan inline: the statusline runs on every keystroke-batch and must be instant.
    // Read the cache, render it, and kick off a detached refresh when it has gone stale so
    // the numbers keep moving on their own.
    const staleAfter = +val('stale', '90');
    let cached = null;
    try {
      const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (c.schema === 2) cached = c;
    } catch { /* no usable cache */ }

    const ageSec = cached ? (Date.now() - new Date(cached.scannedAt).getTime()) / 1000 : Infinity;
    // Only spawn a refresh when no scan is already running. Without this check the
    // statusline's refresh tick will stack scans on top of each other indefinitely.
    if (ageSec > staleAfter && !scanInProgress()) {
      try {
        spawn(process.execPath, [process.argv[1], 'scan', '--fresh'], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* best effort */ }
    }
    // --plain forces unstyled output for consumers that mangle raw ANSI: tmux wants its own
    // #[fg=...] syntax, and starship re-styles whatever a custom module prints.
    const scfg = flag('plain') ? { ...cfg, statuslineStyle: 'plain' } : cfg;
    if (!cached) { process.stdout.write('chaff ⏳ scanning…\n'); return; }
    // This runs in people's shell prompts and tmux status bars. A throw here — a cache written
    // by a concurrent scan, a field that moved between versions — would break their prompt on
    // every keystroke, which is far worse than showing nothing. Never let that happen.
    try {
      process.stdout.write(renderStatusline(cached, scfg) + (ageSec > staleAfter ? ' ↻' : '') + '\n');
    } catch {
      process.stdout.write('chaff ⏳\n');
    }
    return;
  }

  let s;
  if (flag('fresh')) {
    s = scan(cfg, { deep: (flag('deep') || flag('full')) });
    if (s) writeCache(s);
    else {
      s = readCache();
      if (!s) { process.stderr.write('chaff: a scan is already running; try again in a moment\n'); process.exit(3); }
      warn('a scan is already running — showing the last cached result instead');
    }
  } else {
    s = cachedScan(cfg, { deep: (flag('deep') || flag('full')) });
  }

  if (sub === 'scan' || sub === 'status') {
    // `explain` also lands as a bare word: the slash command forwards $ARGUMENTS positionally.
    const explain = flag('explain') || argv.includes('explain');
    process.stdout.write(json ? JSON.stringify(s, null, 2) + '\n'
      : renderScan(s, cfg, { width: termWidth(val('width')), explain }));
    return;
  }

  if (sub === 'top') {
    process.stdout.write(json ? JSON.stringify(s.processes, null, 2) + '\n' : renderTop(s, +val('limit', '20')));
    return;
  }

  if (sub === 'worktrees' || sub === 'wt') {
    process.stdout.write(json ? JSON.stringify(s.worktrees, null, 2) + '\n'
      : renderWorktrees(s, cfg, { dirtyOnly: flag('dirty') }));
    return;
  }

  if (sub === 'doctor') {
    const d = buildPlan(s, cfg);
    process.stdout.write(renderDoctor(s, d, cfg));
    return;
  }

  const plan = buildPlan(s, cfg);

  if (sub === 'plan') {
    process.stdout.write(json ? JSON.stringify(plan, null, 2) + '\n' : renderScan(s, cfg) + renderPlan(plan));
    return;
  }

  if (sub === 'apply' || sub === 'clean' || sub === 'reap') {
    const maxTier = sub === 'reap' ? 1 : tierArg('1');
    const dryRun = flag('dry-run');
    if (maxTier >= 2 && !flag('yes') && !dryRun) {
      process.stderr.write('refusing to apply tier 2 without --yes\n'); process.exit(2);
    }
    if (maxTier >= 3 && !flag('force') && !dryRun) {
      process.stderr.write('tier 3 touches running work or uncommitted code; pass --force to proceed\n'); process.exit(2);
    }
    const useTrash = cfg.trash !== false && !flag('no-trash');
    const results = applyPlan(plan, { maxTier, dryRun, useTrash });
    if (!dryRun && useTrash) {
      const purged = trashPurge(cfg.trashTtlDays ?? 7);
      if (purged) warn(`purged ${purged} trash entr${purged === 1 ? 'y' : 'ies'} older than ${cfg.trashTtlDays ?? 7}d`);
    }
    if (json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
    for (const r of results) {
      process.stdout.write(`  ${r.status.padEnd(8)} ${r.kind.padEnd(16)} ${r.target.replace(HOME, '~')}${r.note ? `  (${r.note})` : ''}\n`);
    }
    const done = results.filter((r) => r.status === 'done');
    const trashed = done.filter((r) => r.trash).length;
    process.stdout.write(`\n  ${done.length}/${results.length} applied · ~${gb(done.reduce((n, r) => n + r.reclaimMb, 0))}GB reclaimed\n`);
    if (trashed) process.stdout.write(`  ${trashed} moved to trash, recoverable for ${cfg.trashTtlDays ?? 7} days · chaff trash\n`);
    process.stdout.write('\n');
    return;
  }

  process.stderr.write(`unknown subcommand: ${sub}\n${HELP}`);
  process.exit(1);
}

// Run the CLI only when invoked directly, so tests can import the pure functions.
// npm installs the bin as a symlink (global installs and npx alike), and Node resolves the
// main module through it while argv[1] keeps the link's path — compared raw, they never
// matched and `chaff` exited 0 having done nothing. Compare real paths.
const realArgv1 = () => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } };
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realArgv1()).href;
if (invokedDirectly) main();
