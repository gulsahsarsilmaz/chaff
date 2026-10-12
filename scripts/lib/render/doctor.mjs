/**
 * `chaff doctor`: why this machine is slow or full, and the one command to run about it.
 */
import { paths } from '../paths.mjs';
import { gb } from './format.mjs';
import { trashList } from '../trash.mjs';

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
