/**
 * `chaff status`: the tiles, the bars, the per-project table and the shared stores.
 */
import { STORE_BY_NAME } from '../catalog.mjs';
import { run } from '../exec.mjs';
import { paths } from '../paths.mjs';
import { bar, fit, gb, paint, termWidth, wrap } from './format.mjs';
import { breaches, junkMb } from '../../thresholds.mjs';

/**
 * One description of the five headline metrics, shared by the tile row and the legend.
 * `2d` and `50wt` are unreadable without it — the abbreviations only make sense to someone
 * who already knows what chaff measures, which is nobody on their first day.
 */
export function metrics(s, cfg) {
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
export function sizedAgo(st) {
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
