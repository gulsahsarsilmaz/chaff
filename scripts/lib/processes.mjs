/**
 * Which toolchain processes are running, and which project each belongs to.
 */
import path from 'node:path';
import { classify, isDaemon, isWork } from './catalog.mjs';
import { run } from './exec.mjs';
import { IS_WIN } from './paths.mjs';
import { windowsProcesses } from './platform/windows.mjs';

export function etimeToSeconds(etime) {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d, h, mm, ss] = m;
  return (+(d || 0)) * 86400 + (+(h || 0)) * 3600 + (+mm) * 60 + (+ss);
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
export function attributeByCwd(procs, projectRoots) {
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
export function allProcessCwds() {
  if (process.platform === 'win32') return [];
  // -b: never block on a stale network mount (it would hang until the timeout); -w: quiet.
  const raw = run('lsof', ['-b', '-w', '-d', 'cwd', '-Fn'], { timeout: 20_000 });
  return raw.split('\n').filter((l) => l[0] === 'n').map((l) => l.slice(1));
}

export function snapshotProcesses() {
  const raw = IS_WIN ? '' : run('ps', ['-ww', '-Ao', 'pid=,ppid=,rss=,%cpu=,etime=,command=']);
  const procs = IS_WIN ? windowsProcesses() : [];
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
