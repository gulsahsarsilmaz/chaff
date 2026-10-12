/**
 * Carrying out a plan. Each action is re-checked at the moment it runs (the process is still
 * the one planned, the path still exists) and its real outcome is reported, not its intent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAlive, run } from './exec.mjs';
import { IS_WIN } from './paths.mjs';
import { POWERSHELL } from './platform/windows.mjs';
import { dirSizeMb } from './sizes.mjs';
import { removeTree, trashPath } from './trash.mjs';

/** Block without spinning, in a synchronous context. */
export const waitMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * True when `pid` is still running exactly `expected`. ps does not truncate when piped, so
 * any difference means a different process — a recycled pid now running a bare `node` REPL
 * must not pass for the `node …/vite.js` that was planned.
 */
export function sameProcess(pid, expected, read = procCommand) {
  if (!expected) return false;
  const now = read(pid);
  return !!now && now === expected.trim();
}

export function procCommand(pid) {
  return run('ps', ['-ww', '-o', 'command=', '-p', String(pid)]).trim();
}

/** One process, by pid, from Win32_Process: its command line and when it started. */
export function winProcInfo(pid) {
  if (!/^\d+$/.test(String(pid))) return null;
  const ps = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${+pid}"; `
    + 'if ($p) { [pscustomobject]@{ cmd = $(if ($p.CommandLine) { $p.CommandLine } else { $p.Name }); '
    + 'age = $(if ($p.CreationDate) { [int]((Get-Date) - $p.CreationDate).TotalSeconds } else { 0 }) } | ConvertTo-Json -Compress }';
  try {
    const j = JSON.parse(run(POWERSHELL[0], [...POWERSHELL[1], ps], { timeout: 30_000 }) || 'null');
    return j ? { cmd: String(j.cmd ?? ''), startMs: Date.now() - Math.max(0, j.age | 0) * 1000 } : null;
  } catch { return null; }
}

/**
 * Windows identity check: the same command line, and — when the plan recorded it — a start
 * time within a few seconds of the planned one. Both are rounded to whole seconds on the way
 * in, so a small tolerance is needed; a recycled pid is a different start, minutes apart.
 */
export function sameWinProcess(info, expectedCmd, expectedStartMs, toleranceMs = 5000) {
  if (!info || !expectedCmd || info.cmd.trim() !== expectedCmd.trim()) return false;
  return expectedStartMs == null || Math.abs(info.startMs - expectedStartMs) <= toleranceMs;
}

/**
 * How one planned command runs on Windows. `rm` and `kill` are done natively. npm, npx, pnpm
 * and yarn are .cmd shims that Node will not start without a shell, so they go through
 * cmd.exe — but only with arguments that are plain words, which every planned command is
 * (they are constants in this file). Anything else is refused rather than quoted.
 */
export const WIN_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
export function winCommand(cmd, args) {
  if (cmd === 'rm') return { internal: 'rm', target: args[args.length - 1] };
  if (cmd === 'kill') return { internal: 'kill', pids: args.filter((x) => /^\d+$/.test(x)).map(Number) };
  if (WIN_SHIMS.has(cmd)) {
    const all = [cmd, ...args];
    if (!all.every((x) => /^[\w@.:=\/-]+$/.test(x))) throw new Error(`refusing to run ${JSON.stringify(all.join(' '))} through cmd.exe`);
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', all.join(' ')], verbatim: true };
  }
  return { file: cmd, args };
}

export const taskkill = (pids, force) => {
  for (const pid of pids) {
    try { execFileSync('taskkill', [...(force ? ['/F'] : []), '/PID', String(pid)], { stdio: 'ignore', timeout: 30_000 }); }
    catch { /* console processes refuse a polite close; confirmDead escalates */ }
  }
};

/**
 * `kill` exits 0 once the signal is delivered, which says nothing about whether the process
 * acted on it — dev servers under a package-manager wrapper routinely ignore SIGTERM and
 * stay up, and reporting those as "done" is how a cleanup silently accomplishes nothing.
 * Wait for the exit, escalate once, and report what actually happened.
 */
export function confirmDead(pids, graceMs = 2000) {
  const alive = () => pids.filter((p) => isAlive(p));
  for (const deadline = Date.now() + graceMs; Date.now() < deadline && alive().length; ) waitMs(100);
  const survivors = alive();
  if (!survivors.length) return { ok: true, escalated: false };
  if (IS_WIN) taskkill(survivors, true);
  else try { execFileSync('kill', ['-KILL', ...survivors.map(String)], { stdio: 'ignore' }); } catch { /* raced */ }
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
    if (a.pid && !isAlive(a.pid)) { results.push({ ...a, status: 'skipped', note: 'process already gone' }); continue; }
    // …and a live pid may no longer be the process that was planned. Signal only the pids
    // whose command still matches; skip the action outright if the main one does not.
    let cmdLine = a.cmd;
    if (a.cmd[0] === 'kill' && a.expect) {
      const same = IS_WIN
        ? (pid) => sameWinProcess(winProcInfo(pid), a.expect[pid], a.expectStart?.[pid])
        : (pid) => sameProcess(pid, a.expect[pid]);
      if (a.pid && !same(String(a.pid))) {
        results.push({ ...a, status: 'skipped', note: `pid ${a.pid} now belongs to a different process` }); continue;
      }
      cmdLine = a.cmd.filter((x) => !/^\d+$/.test(x) || same(x));
    }
    if ((a.kind === 'rm-artifact' || a.kind === 'rm-store') && !existsSync(a.target)) {
      results.push({ ...a, status: 'skipped', note: 'already gone' }); continue;
    }
    if (a.kind === 'prune-store' && a.recheckMinMb != null && dirSizeMb(a.target) < a.recheckMinMb) {
      results.push({ ...a, status: 'skipped', note: 'no longer over the store threshold' }); continue;
    }

    // Deletions go to the trash when enabled, so a mistake is a rename away from undone.
    if (useTrash && (a.kind === 'rm-artifact' || a.kind === 'rm-store')) {
      try {
        const dest = trashPath(a.target);
        results.push({ ...a, status: 'done', note: 'trashed', trash: dest }); continue;
      } catch (e) {
        // Held open, or the copy across filesystems could not be made and verified: leave it
        // exactly where it is. With the trash on, a failure never becomes a permanent delete.
        if (e.code === 'LOCKED') { results.push({ ...a, status: 'skipped', note: e.message }); continue; }
        const note = e.code === 'PARTIAL' ? e.message : `${e.message.split('\n')[0]} — nothing was deleted`;
        results.push({ ...a, status: 'failed', note }); continue;
      }
    }

    if (IS_WIN) {
      try {
        const w = winCommand(cmdLine[0], cmdLine.slice(1));
        if (w.internal === 'rm') { removeTree(w.target); results.push({ ...a, status: 'done' }); continue; }
        if (w.internal === 'kill') {
          taskkill(w.pids, false);
          const r = confirmDead(w.pids);
          if (!r.ok) { results.push({ ...a, status: 'failed', note: `still alive after taskkill /F: ${r.stubborn.join(', ')}` }); continue; }
          results.push({ ...a, status: 'done', note: r.escalated ? 'did not close; taskkill /F sent' : undefined });
          continue;
        }
        execFileSync(w.file, w.args, { stdio: 'ignore', cwd: a.cwd || process.cwd(), timeout: 180_000, windowsVerbatimArguments: !!w.verbatim });
        results.push({ ...a, status: 'done' });
      } catch (e) {
        results.push({ ...a, status: 'failed', note: e.message.split('\n')[0] });
      }
      continue;
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
