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
import fs, { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureStatusline, removeStatusline, statuslineCommand, GLOBAL_COMMAND } from './statusline-setup.mjs';
import { breaches, junkMb } from './thresholds.mjs';
import { availableUpdate, refreshInBackground, updateNotice, installedVersion } from './update-check.mjs';
import path from 'node:path';
import { planDigest } from './plan-digest.mjs';
import { paths, IS_MAC, IS_WIN, IS_CI } from './lib/paths.mjs';
import { run, warn, setProgress } from './lib/exec.mjs';
import { STORE_BY_NAME, classify } from './lib/catalog.mjs';

export { projectFromWinCmd, treeBytes, walkArtifacts, walkDeps, walkProjectMarkers } from './lib/platform/windows.mjs';
export { markTracked, resolveRoots } from './lib/discover.mjs';

export { STORE_SIZE_TTL_SEC, dirSizesMb, storeSizesMb } from './lib/sizes.mjs';
import { withinRoots } from './lib/processes.mjs';
export { etimeToSeconds, projectFromCmd, withinRoots } from './lib/processes.mjs';
export { defaultBranchFor, isDirty, mergedBranches } from './lib/git.mjs';
import { cachedScan, diskFor, readCache, scan, scanInProgress, writeCache } from './lib/scan.mjs';
export { acquireLock, releaseLock, scanInProgress } from './lib/scan.mjs';
import { LIST_KEYS, loadConfig, parseListValue, readUserConfig, saveConfig } from './lib/config.mjs';
import { trashList, trashPurge, trashRestore } from './lib/trash.mjs';
export { LockedError, __setRenameForTests, moveByCopy, removeTree, trashList, trashPath, trashPurge, trashRestore, trashSlug, treeDiff } from './lib/trash.mjs';
import { buildPlan } from './lib/plan.mjs';
export { buildPlan } from './lib/plan.mjs';
import { applyPlan } from './lib/apply.mjs';
export { applyPlan, sameProcess, sameWinProcess, winCommand, winProcInfo } from './lib/apply.mjs';
export { DEFAULTS, parseListValue } from './lib/config.mjs';
// Re-exported for tests and other entry points that import them from here.
export { classify } from './lib/catalog.mjs';

/**
 * chaff's inventory comes from `find`, `du`, `df` and `ps`. Native Windows has none of them
 * (`find.exe` searches text inside files), so there chaff uses its own scan layer instead: a
 * Node filesystem walk, PowerShell for processes and statfs for disk. See "Windows scan
 * layer" below. Acting has its own Windows half too (see "apply"): directories are trashed by
 * rename and never deleted when something holds them open, processes are stopped with
 * taskkill after their identity is re-checked, and package-manager shims run through cmd.exe
 * with constant arguments only.
 */

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
  const over = new Set(breaches(s, t).map((b) => b.key));
  const junk = junkMb(s);
  return [
    { label: 'TOOLCHAIN MEM', value: `${gb(s.totals.nodeRssMb)}G/${s.totals.nodeProcs}p`,
      sub: `across ${s.totals.nodeProcs} procs`, bad: over.has('memory'),
      means: 'build-tool memory: node, JVM, Unity, cargo, python',
      limit: `> ${gb(t.nodeRssMb)}G`, now: `${gb(s.totals.nodeRssMb)}GB / ${s.totals.nodeProcs}p` },
    { label: 'DAEMONS', value: `${s.totals.daemons}d`,
      sub: `limit ${t.daemons}`, bad: over.has('daemons'),
      means: 'long-lived servers: nx, turbo, tsserver, watchman, LSPs',
      limit: `> ${t.daemons}`, now: `${s.totals.daemons}` },
    { label: 'DISK FREE', value: `${s.disk.freeGb}G`,
      sub: `floor ${t.diskFreeGb}G`, bad: over.has('disk'),
      means: 'free space on the volume holding your first root',
      limit: `< ${t.diskFreeGb}G`, now: `${s.disk.freeGb}GB of ${s.disk.totalGb}GB` },
    { label: 'JUNK', value: `${gb(junk)}G`,
      sub: 'cache + output', bad: over.has('junk'),
      means: 'regenerable build cache and output — excludes node_modules',
      limit: `> ${t.cacheGb}G`, now: `${gb(junk)}GB` },
    { label: 'WORKTREES', value: `${s.totals.worktrees}wt`,
      sub: `limit ${t.worktrees}`, bad: over.has('worktrees'),
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

/** "  · sized 3h ago" for a store size reused from the store cache, so an old number says so. */
function sizedAgo(st) {
  if (!st.reused || !st.sizedAt) return '';
  const h = Math.floor((Date.now() - new Date(st.sizedAt).getTime()) / 3_600_000);
  return h < 1 ? '' : `  · sized ${h}h ago`;
}

export function renderScan(s, cfg, { width = termWidth(), explain = false } = {}) {
  const t = cfg.thresholds, L = [''];
  L.push(`  chaff  ·  ${s.roots.length ? s.roots.join('  ') : 'no project scan'}`);
  if (s.rootsRefused) {
    L.push(`  scope         ${s.rootsRefused.replace(paths.home, '~')} is at or above home — projects, artifacts and`);
    L.push('                worktrees were not scanned.  run from inside a project, or:  chaff config --set=roots=~/code');
  } else if (s.rootsInferred) {
    L.push(`  scope         inferred from cwd — set explicitly:  chaff config --set=roots=${s.roots.map((r) => r.replace(paths.home, '~')).join(',')}`);
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
    const label = p.root.replace(paths.home, '~').replace(/\/\.claude\/worktrees\//, '/wt:');
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
    for (const st of s.stores) L.push(`  ${st.name.padEnd(24)} ${(gb(st.sizeMb) + 'GB').padStart(8)}${st.safe ? '' : `  (${STORE_BY_NAME.get(st.name)?.howTo || 'not auto-prunable'})`}  ${st.path.replace(paths.home, '~')}${sizedAgo(st)}`);
  }
  if (explain) L.push(renderExplain(s, cfg, width));
  L.push('');
  return L.join('\n');
}

export function renderPlan(plan) {
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
      L.push(`      ${a.kind.padEnd(16)}${(gb(a.reclaimMb) + 'GB').padStart(8)}  ${a.target.replace(paths.home, '~')}${a.blocked ? `  [${a.blocked}]` : ''}`);
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
  const over = new Set(breaches(s, t).map((b) => b.key));
  const junk = junkMb(s);
  // Counts of things a machine may simply not have — no daemons running, no worktrees
  // checked out — are dropped rather than shown as a green zero. A permanent `0d` on a
  // Rust or Python codebase is noise pretending to be a metric. Memory, disk and junk
  // always render: zero there is a real reading, not an absent concept.
  const segs = [
    [true, over.has('memory'), `${gb(s.totals.nodeRssMb)}G/${s.totals.nodeProcs}p`],
    [s.totals.daemons > 0, over.has('daemons'), `${s.totals.daemons}d`],
    [true, over.has('disk'), `${s.disk.freeGb}G free`],
    [true, over.has('junk'), `${gb(junk)}G junk`],
    [s.totals.worktrees > 0, over.has('worktrees'), `${s.totals.worktrees}wt`],
  ];
  return 'chaff' + scope + ' ' + segs.filter(([show]) => show).map(([, bad, text]) => mark(bad, text))
    .join(style === 'color' ? `${ANSI.dim} · ${ANSI.off}` : ' · ');
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
    chaff version                         installed version, and how to update if newer
    chaff config                          show current settings
    chaff config --set=policy=propose     propose | auto-orphans | auto-threshold
    chaff config --set=roots=~/code,~/work  directories to scan

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
    --dry-run     show, do not act      --deep      also size node_modules, re-size stores
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

export function renderTop(s, limit) {
  const procs = s.processes
    .filter((p) => p.type !== 'other')
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, limit);
  const L = ['', `  chaff top  ·  ${s.totals.nodeProcs} processes  ·  ${gb(s.totals.nodeRssMb)}GB`, '  ' + '─'.repeat(76)];
  L.push('     PID   RSS    CPU   AGE  TYPE          PROJECT');
  for (const p of procs) {
    const age = p.ageSec > 3600 ? `${Math.round(p.ageSec / 3600)}h` : `${Math.round(p.ageSec / 60)}m`;
    L.push(`  ${String(p.pid).padStart(6)} ${(p.rssMb + 'M').padStart(6)} ${(p.cpu.toFixed(0) + '%').padStart(5)} ${age.padStart(5)}  ${p.type.padEnd(13)} ${(p.project || '—').replace(paths.home, '~')}`);
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
    for (const [proj, mb] of top) L.push(`  ${(gb(mb) + 'GB').padStart(8)}  ${proj.replace(paths.home, '~')}`);
  }
  L.push('');
  return L.join('\n');
}

// ── doctor: why is this machine slow, and what should I do about it ───────────

export function renderDoctor(s, plan, cfg) {
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
      detail: biggest.map((b) => `${(gb(b.sizeMb) + 'GB').padStart(7)}  ${b.path.replace(paths.home, '~')}`).join('\n'),
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
          : cargoDirs.slice(0, 3).map((a) => `${(gb(a.sizeMb) + 'GB').padStart(7)}  ${a.path.replace(paths.home, '~')}`).join('\n'))
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
        `${(p.cpu.toFixed(0) + '%').padStart(7)}  ${p.type} pid ${p.pid}, up ${Math.round(p.ageSec / 60)}m  ${(p.project || '?').replace(paths.home, '~')}`).join('\n'),
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

export function renderWorktrees(s, cfg, { dirtyOnly = false } = {}) {
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
      w.hasProcess ? (w.busyUnknown ? 'may be in use' : 'in use') : null,
    ].filter(Boolean).join(' · ');

    L.push(`  ${age.padStart(4)}  ${(w.branch || 'detached HEAD').slice(0, 50)}`);
    L.push(`        ${w.path.replace(paths.home, '~')}`);
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
const plistPath = () => path.join(paths.home, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function scheduleArgs(tier) {
  return [process.execPath, process.argv[1], 'clean', `--tier=${tier}`, '--yes', '--fresh'];
}

/**
 * A per-user daily task (schtasks ships with Windows; no admin rights needed). The task runs
 * a small .cmd in chaff's home rather than the command itself: /TR is capped at 261
 * characters, which a node path plus a script path can exceed, and cmd.exe is what gives the
 * task a log via `>>`. cmd.exe expands `%` and ends strings at `"`, so a path containing
 * either is refused rather than escaped.
 */
export function schtasksSpec(hour, tier, { exe, script, log, home }) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`--hour must be 0-23, got ${hour}`);
  if (!Number.isInteger(tier) || tier < 1 || tier > 2) throw new Error(`only tier 1 or 2 can be scheduled, got ${tier}`);
  for (const p of [exe, script, log, home]) {
    if (/["%\r\n]/.test(p)) throw new Error(`cannot schedule from a path containing " or %: ${p}`);
  }
  const wrapper = path.win32.join(home, 'nightly.cmd');
  const wrapperBody = `@echo off\r\n"${exe}" "${script}" clean --tier=${tier} --yes --fresh >> "${log}" 2>&1\r\n`;
  return {
    wrapper, wrapperBody,
    args: ['/Create', '/F', '/SC', 'DAILY', '/TN', PLIST_LABEL, '/ST', `${String(hour).padStart(2, '0')}:00`, '/TR', `"${wrapper}"`],
  };
}
const CRON_MARK = '# chaff nightly cleanup';

function scheduleInstall(hour, tier) {
  mkdirSync(paths.chaffHome, { recursive: true });
  const [exe, ...rest] = scheduleArgs(tier);
  const log = paths.nightlyLog;

  if (IS_WIN) {
    let spec;
    try { spec = schtasksSpec(hour, tier, { exe, script: rest[0], log, home: paths.chaffHome }); }
    catch (e) { return { via: 'schtasks', entry: PLIST_LABEL, log, err: e.message }; }
    try {
      writeFileSync(spec.wrapper, spec.wrapperBody);
      execFileSync('schtasks', spec.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      return { via: 'schtasks', entry: `${PLIST_LABEL} → ${spec.wrapper}`, log, err: null };
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
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), plist);
  run('launchctl', ['unload', plistPath()]);
  try {
    execFileSync('launchctl', ['load', plistPath()], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    return { via: 'launchd', entry: plistPath(), log, err: null };
  } catch (e) { return { via: 'launchd', entry: plistPath(), log, err: e.stderr || e.message }; }
}

function scheduleStatus() {
  if (IS_WIN) {
    const out = run('schtasks', ['/Query', '/TN', PLIST_LABEL]);
    const found = out.includes(PLIST_LABEL);
    return { via: 'schtasks', installed: found, loaded: found, entry: PLIST_LABEL, log: paths.nightlyLog };
  }
  if (!IS_MAC) {
    const line = run('crontab', ['-l']).split('\n').find((l) => l.includes(CRON_MARK));
    return { via: 'cron', installed: !!line, loaded: !!line, entry: line || '(none)', log: paths.nightlyLog };
  }
  return {
    via: 'launchd', installed: existsSync(plistPath()),
    loaded: run('launchctl', ['list']).split('\n').some((l) => l.includes(PLIST_LABEL)),
    entry: plistPath(), log: paths.nightlyLog,
  };
}

function scheduleRemove() {
  if (IS_WIN) {
    rmSync(path.join(paths.chaffHome, 'nightly.cmd'), { force: true });
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', PLIST_LABEL], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  if (!IS_MAC) {
    const kept = run('crontab', ['-l']).split('\n').filter((l) => l && !l.includes(CRON_MARK));
    try { execFileSync('crontab', ['-'], { input: kept.join('\n') + '\n', stdio: ['pipe', 'ignore', 'ignore'] }); return true; }
    catch { return false; }
  }
  run('launchctl', ['unload', plistPath()]);
  try { unlinkSync(plistPath()); return true; } catch { return false; }
}

// ── cli ───────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['scan', 'status', 'plan', 'top', 'doctor', 'worktrees', 'wt', 'statusline',
  'schedule', 'trash', 'restore', 'apply', 'clean', 'reap', 'ci', 'config', 'mcp', 'help', 'version']);

/** `--set=key=[...]`: a malformed value is the user's typo, so say so instead of a stack trace. */
function parseJsonValue(k, v) {
  try { return JSON.parse(v); } catch (e) {
    process.stderr.write(`chaff: --set=${k}: not valid JSON (${e.message}). Quote it, e.g. --set=${k}='[1,2]'\n`);
    process.exit(2);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'scan';
  // A typo must fail at once: falling through to the end meant a full scan first, and on
  // Windows the "cleanup not enabled" refusal, before "unknown subcommand".
  if (!SUBCOMMANDS.has(sub)) { process.stderr.write(`chaff: unknown subcommand: ${sub}\n\n${HELP}`); process.exit(1); }
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

  if (sub === 'version' || flag('version') || flag('v')) {
    process.stdout.write(`chaff ${installedVersion() || 'unknown'}\n`);
    const note = updateNotice({ cfg });
    if (note) process.stdout.write(note + '\n');
    refreshInBackground({ cfg });
    return;
  }

  if (sub === 'config') {
    const set = val('set');
    if (set) {
      const [k, ...rest] = set.split('=');
      const v = rest.join('=');
      const parsed = LIST_KEYS.includes(k) ? parseListValue(v)
        : v === 'true' ? true : v === 'false' ? false
        : /^-?\d+(\.\d+)?$/.test(v) ? +v : v.startsWith('[') ? parseJsonValue(k, v) : v;
      // Merge into what the user set, not the merged config: saving defaults would pin them
      // (the RAM-scaled nodeRssMb among them) so a later default never reached this user.
      const next = readUserConfig();
      if (k.includes('.')) { const [a, b] = k.split('.'); next[a] = { ...(next[a] || {}), [b]: parsed }; }
      else next[k] = parsed;
      saveConfig(next);
      process.stdout.write(`set ${k} = ${JSON.stringify(parsed)}  (${paths.config})\n`);
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

  // On native Windows only reporting runs past this point. help/config/mcp returned above.

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
    const after = diskFor(scanned.roots[0] || paths.home);
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
      process.stdout.write(`  ${age.padStart(5)}  ${e.origin.replace(paths.home, '~')}\n         id: ${e.id}\n`);
    }
    process.stdout.write(`\n  chaff restore <id>    chaff trash --empty\n\n`);
    return;
  }

  if (sub === 'restore') {
    const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!id) { process.stderr.write('usage: chaff restore <id>   (see: chaff trash)\n'); process.exit(2); }
    const r = trashRestore(id);
    process.stdout.write(r.ok ? `  restored ${r.origin.replace(paths.home, '~')}\n` : `  could not restore: ${r.why}\n`);
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
      saveConfig({ ...readUserConfig(), autoStatusline: false });
      let r;
      try { r = removeStatusline(); } catch (e) { r = { status: 'error', why: e.message }; }
      const say = { removed: 'chaff statusline removed', none: 'no statusline was set',
                    foreign: 'your statusline is not chaff\'s; left it alone', error: `could not edit settings: ${r.why}` };
      process.stdout.write(`  ${say[r.status]}\n  automatic setup is off (autoStatusline=false)\n`);
      process.exit(r.status === 'error' ? 1 : 0);
    }
    const self = realpathSync(fileURLToPath(import.meta.url));
    // npx runs from a cache directory that is cleared without notice; a statusline pointing
    // there would break silently some days later.
    if (self.includes(`${path.sep}_npx${path.sep}`)) {
      process.stderr.write('chaff: run this from a global install (npm i -g @gulsahsarsilmaz/chaff) or the Claude Code plugin, not npx.\n');
      process.exit(2);
    }
    saveConfig({ ...readUserConfig(), autoStatusline: true });
    // Launched through a bin on PATH (npm -g, Homebrew, nvm), write the bare command: the
    // resolved path is a versioned directory that the next upgrade deletes.
    const viaBin = path.basename(process.argv[1] || '') === 'chaff';
    const want = viaBin ? GLOBAL_COMMAND : statuslineCommand(self);
    let r;
    try { r = ensureStatusline(want); } catch (e) { r = { status: 'error', why: e.message }; }
    const say = { installed: 'chaff statusline installed', updated: 'chaff statusline repointed to this install',
                  current: 'chaff statusline already installed', error: `could not edit settings: ${r.why}`,
                  foreign: 'you already have a statusline, so it was left alone. To show chaff under it, add this\n'
                    + `  line to your statusline script:\n\n    ${want}` };
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
      const c = JSON.parse(readFileSync(paths.scanCache, 'utf8'));
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
      // A newer release shows here until it is installed; the network check behind it runs
      // detached at most once a day, so the prompt never waits on it.
      refreshInBackground({ cfg });
      const up = availableUpdate({ cfg });
      const upText = !up ? '' : scfg.statuslineStyle === 'color' ? ` ${ANSI.yellow}↑${up.latest}${ANSI.off}` : ` ↑${up.latest}`;
      process.stdout.write(renderStatusline(cached, scfg) + (ageSec > staleAfter ? ' ↻' : '') + upText + '\n');
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
    // --expect binds this run to a plan someone already saw (the MCP server passes it): if
    // what would be applied now differs from what they agreed to, apply nothing.
    const expect = val('expect');
    if (expect && planDigest(plan.actions, maxTier) !== expect) {
      process.stderr.write('the plan changed since it was shown; nothing was applied. Run `chaff plan` again\n'); process.exit(2);
    }
    const useTrash = cfg.trash !== false && !flag('no-trash');
    const results = applyPlan(plan, { maxTier, dryRun, useTrash });
    if (!dryRun && useTrash) {
      const purged = trashPurge(cfg.trashTtlDays ?? 7);
      if (purged) warn(`purged ${purged} trash entr${purged === 1 ? 'y' : 'ies'} older than ${cfg.trashTtlDays ?? 7}d`);
    }
    if (json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
    for (const r of results) {
      process.stdout.write(`  ${r.status.padEnd(8)} ${r.kind.padEnd(16)} ${r.target.replace(paths.home, '~')}${r.note ? `  (${r.note})` : ''}\n`);
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
