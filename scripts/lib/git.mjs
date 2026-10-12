/**
 * git worktrees and branch state: what is merged, what is dirty, how recently it moved.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { run } from './exec.mjs';
import { nativePath } from './paths.mjs';

// ── git worktrees ─────────────────────────────────────────────────────────────

export function worktreesFor(repo) {
  const out = run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { timeout: 30_000 });
  if (!out) return [];
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: nativePath(line.slice(9)), branch: null, locked: false, prunable: false, detached: false };
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

export const lastCommitDays = (dir) => {
  const ts = run('git', ['-C', dir, 'log', '-1', '--format=%ct'], { timeout: 15_000 }).trim();
  return ts ? (Date.now() / 1000 - +ts) / 86400 : null;
};
