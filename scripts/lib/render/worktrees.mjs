/**
 * `chaff worktrees`: every worktree, including the ones held back as dirty, with why.
 */
import { run } from '../exec.mjs';
import { paths } from '../paths.mjs';

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
