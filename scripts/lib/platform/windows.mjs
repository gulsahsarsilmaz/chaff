/**
 * Native Windows has no find, du, df or ps. This is chaff's own scan layer there: a Node
 * filesystem walk with the same semantics as the find/du calls (pinned against them in
 * test/windows.test.mjs), PowerShell for processes, statfs for disk.
 */
import fs, { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_NAMES, PROJECT_MARKERS, classify } from '../catalog.mjs';
import { run } from '../exec.mjs';
import { paths } from '../paths.mjs';

// Used only on native Windows, in place of find/du/df/ps. Each piece keeps the semantics of
// the command it replaces, so everything downstream reads the same shape of answer.

/** A `find -name` pattern (`*` and `?`) as a RegExp. */
export const nameRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/**
 * find(1)'s walk: `root` is depth 0, nothing deeper than `maxDepth` is visited, and only real
 * directories are descended. A symlink or junction is visited as itself and never followed,
 * as `find -P` does: libuv reports every reparse point as a link, not a directory, so a
 * junction into another drive or back up the tree cannot drag the walk along. `visit`
 * returns 'prune' to keep the walk out of a directory it has matched.
 */
export function walkTree(root, maxDepth, visit) {
  let st;
  try { st = lstatSync(root); } catch { return; }
  const stack = [[root, { name: path.basename(root), isDirectory: () => st.isDirectory() }, 0]];
  while (stack.length) {
    const [full, d, depth] = stack.pop();
    if (visit(full, d) === 'prune' || !d.isDirectory() || depth >= maxDepth) continue;
    let entries;
    try { entries = readdirSync(full, { withFileTypes: true }); } catch { continue; }   // unreadable: skip, like find
    for (let i = entries.length - 1; i >= 0; i--) stack.push([path.join(full, entries[i].name), entries[i], depth + 1]);
  }
}

/** `find root -maxdepth N -name node_modules -prune -o ( -name M … ) -print` */
export function walkProjectMarkers(root, maxDepth, markers = PROJECT_MARKERS) {
  const res = markers.map(nameRe), hits = [];
  walkTree(root, maxDepth, (full, d) => {
    if (d.name === 'node_modules') return 'prune';
    if (res.some((r) => r.test(d.name))) hits.push(full);
    return null;
  });
  return hits;
}

/** `find root -maxdepth N -name node_modules -prune -o -type d ( -name A … ) -print -prune` */
export function walkArtifacts(root, maxDepth, names = ARTIFACT_NAMES) {
  const want = new Set(names), hits = [];
  walkTree(root, maxDepth, (full, d) => {
    if (d.name === 'node_modules') return 'prune';
    if (d.isDirectory() && want.has(d.name)) { hits.push(full); return 'prune'; }
    return null;
  });
  return hits;
}

/** `find root -maxdepth N -type d -name node_modules -print -prune` */
export function walkDeps(root, maxDepth) {
  const hits = [];
  walkTree(root, maxDepth, (full, d) => {
    if (d.isDirectory() && d.name === 'node_modules') { hits.push(full); return 'prune'; }
    return null;
  });
  return hits;
}

/**
 * Bytes under `p`, the way `du -s` counts them: links are not followed, and a file with
 * several hard links is counted once per `seen` set — pnpm hard-links its whole store into
 * every node_modules, so counting each link would multiply the biggest number on the screen.
 */
export function treeBytes(p, seen = new Set()) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = lstatSync(cur); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let names;
      try { names = readdirSync(cur); } catch { continue; }
      for (const n of names) stack.push(path.join(cur, n));
      continue;
    }
    if (st.nlink > 1) {
      let key = cur;
      // A Windows file id is 64 bits; only a bigint stat carries it intact.
      try { const b = lstatSync(cur, { bigint: true }); key = `${b.dev}:${b.ino}`; } catch { /* count it */ }
      if (seen.has(key)) continue;
      seen.add(key);
    }
    total += st.size;
  }
  return total;
}

/** `du -sk a b c` output: one `<KB>\t<path>` line each, hard links counted once across all. */
export function duLines(paths) {
  const seen = new Set();
  return paths.map((p) => `${Math.round(treeBytes(p, seen) / 1024)}\t${p}`).join('\n');
}

export const POWERSHELL = ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']];

// One CIM query for every process. Age is computed in PowerShell, where CreationDate is
// already a DateTime: serialised, it becomes "/Date(…)/" on 5.1 and ISO on 7.
export const PS_PROCESSES = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $now = Get-Date; '
  + '$p = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ '
  + 'pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; ws = [double]$_.WorkingSetSize; '
  + 'age = $(if ($_.CreationDate) { [int](($now - $_.CreationDate).TotalSeconds) } else { 0 }); '
  + 'cmd = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }) } }; '
  + 'ConvertTo-Json -InputObject @($p) -Compress';

/**
 * Processes, from Win32_Process. The classifiers are written against `/` paths, so they see
 * the command line with backslashes flipped; the record keeps the original. CPU is not
 * sampled (it would take two snapshots), so it reads 0.
 */
export function windowsProcesses() {
  let rows = [];
  try { rows = JSON.parse(run(POWERSHELL[0], [...POWERSHELL[1], PS_PROCESSES], { timeout: 60_000 }) || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [rows];
  const procs = [];
  for (const r of rows) {
    if (!r || !Number.isInteger(r.pid) || r.pid === process.pid || r.pid === 0) continue;
    const cmd = String(r.cmd ?? '');
    procs.push({
      pid: r.pid, ppid: r.ppid | 0, rssMb: Math.round((+r.ws || 0) / 1048576), cpu: 0,
      ageSec: Math.max(0, r.age | 0), startMs: Date.now() - Math.max(0, r.age | 0) * 1000, cmd, type: classify(cmd.replace(/\\/g, '/')), project: projectFromWinCmd(cmd),
    });
  }
  return procs;
}

/**
 * projectFromCmd for a Windows command line: the directory holding the first node_modules
 * on a drive-letter path. Quoted arguments may contain spaces ("C:\Users\Jo Smith\…");
 * unquoted ones end at whitespace. The drive letter is upper-cased to match scanned roots.
 */
export function projectFromWinCmd(cmd) {
  const m = cmd.match(/"([A-Za-z]:[\\/][^"]*?)[\\/]node_modules[\\/]/)
    || cmd.match(/(?:^|\s)([A-Za-z]:[\\/][^\s"]*?)[\\/]node_modules[\\/]/);
  if (!m) return null;
  const p = path.win32.normalize(m[1]);
  return p[0].toUpperCase() + p.slice(1);
}

/** `df -k dir` for Windows: statfs (Node >= 18.15), else PowerShell's view of the drive. */
export function windowsDisk(dir) {
  let total = 0, used = 0, free = 0;
  try {
    const s = fs.statfsSync(dir);
    total = s.blocks * s.bsize; free = s.bavail * s.bsize; used = (s.blocks - s.bfree) * s.bsize;
  } catch {
    const drive = path.parse(path.resolve(dir)).root.replace(/[\\/:]+$/, '');
    if (/^[A-Za-z]$/.test(drive)) {
      try {
        const j = JSON.parse(run(POWERSHELL[0], [...POWERSHELL[1],
          `Get-PSDrive -Name ${drive} | Select-Object Used,Free | ConvertTo-Json -Compress`], { timeout: 30_000 }));
        used = +j.Used || 0; free = +j.Free || 0; total = used + free;
      } catch { /* unknown */ }
    }
  }
  const g = (b) => +(b / 1024 ** 3).toFixed(1);
  return { totalGb: g(total), usedGb: g(used), freeGb: g(free), pctUsed: total ? Math.round((used / total) * 100) : 0 };
}
