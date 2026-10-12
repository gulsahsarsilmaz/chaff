/**
 * The plan: every cleanup chaff could do, sorted into three tiers by how much it would hurt.
 * Pure apart from `exists`, which callers may inject: the same scan always yields the same plan.
 */
import { existsSync } from 'node:fs';
import { STORE_BY_NAME, isDaemon, isReapable, isServer, isWork } from './catalog.mjs';
import { withinRoots } from './processes.mjs';
import { breaches } from '../thresholds.mjs';

// ── plan ──────────────────────────────────────────────────────────────────────

export function buildPlan(s, cfg, { exists = existsSync } = {}) {
  const actions = [];
  // What each pid was when the plan was made. A plan can be built from a scan minutes old,
  // and a pid freed since may now belong to something else entirely; applyPlan checks this
  // before it signals anything.
  const cmdOf = new Map(s.processes.map((p) => [p.pid, p.cmd]));
  const expectFor = (cmd) => Object.fromEntries(cmd.filter((x) => /^\d+$/.test(x) && cmdOf.has(+x)).map((x) => [x, cmdOf.get(+x)]));
  // Windows also records when each process started: a pid can be reused within seconds there,
  // and a respawned dev server can carry the identical command line.
  const startOf = new Map(s.processes.filter((p) => p.startMs != null).map((p) => [p.pid, p.startMs]));
  const startFor = (cmd) => Object.fromEntries(cmd.filter((x) => /^\d+$/.test(x) && startOf.has(+x)).map((x) => [x, startOf.get(+x)]));
  const isProtected = (p) => (cfg.protect || []).some((frag) => p.includes(frag));
  const add = (a) => {
    if (isProtected(a.target)) return;
    if (a.cmd?.[0] === 'kill') {
      a.expect = expectFor(a.cmd);
      const started = startFor(a.cmd);
      if (Object.keys(started).length) a.expectStart = started;
    }
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
    if (!exists(p.project)) {
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
      // A size reused from the store cache can be up to a day old; applyPlan re-measures
      // before acting on it, so a stale number can only ever narrow a cleanup.
      ...(st.reused ? { recheckMinMb: cfg.thresholds.storeGb * 1024 } : {}),
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
    if (st.safe || STORE_BY_NAME.get(st.name)?.rm === false) continue;
    add({
      tier: 3, kind: 'rm-store', target: st.path, reclaimMb: st.sizeMb,
      reason: `${st.name} is ${(st.sizeMb / 1024).toFixed(1)}GB — deleting means ${STORE_BY_NAME.get(st.name)?.cost || 're-downloading its contents'}`,
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
        : wt.hasProcess ? (wt.busyUnknown ? `${age}d stale, but Windows cannot tell whether something is using it`
          : `${age}d stale, but a process is running in it`)
        : wt.dirty === true ? `${age}d stale on ${wt.branch || 'detached HEAD'} — HAS UNCOMMITTED CHANGES, commit or stash first`
        : !wt.merged ? `${age}d stale on ${wt.branch || 'detached HEAD'} — NOT merged into ${wt.baseBranch}; its commits exist nowhere else`
        : `${age}d stale on ${wt.branch || 'detached HEAD'}`,
      cmd: ['git', '-C', wt.repo, 'worktree', 'remove', wt.path],
    });
  }

  const breached = breaches(s, cfg.thresholds).map((b) => b.text);

  actions.sort((a, b) => a.tier - b.tier || b.reclaimMb - a.reclaimMb);
  const sum = (tier) => actions.filter((a) => a.tier === tier).reduce((n, a) => n + a.reclaimMb, 0);
  return {
    scannedAt: s.scannedAt, policy: cfg.policy, breached, actions,
    reclaimable: { tier1Mb: sum(1), tier2Mb: sum(2), tier3Mb: sum(3) },
  };
}
