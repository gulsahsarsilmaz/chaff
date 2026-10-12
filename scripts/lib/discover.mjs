/**
 * Finding things: which directories to scan, which projects live there, and which
 * regenerable artifacts and node_modules installs they contain.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACTS, ARTIFACT_NAMES, PROJECT_MARKERS } from './catalog.mjs';
import { run, warn } from './exec.mjs';
import { IS_WIN, expand, nativePath, paths } from './paths.mjs';
import { walkArtifacts, walkDeps, walkProjectMarkers } from './platform/windows.mjs';
import { scan } from './scan.mjs';

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
      warn(`none of the configured roots exist — nothing to scan. Fix "roots" in ${paths.config}`);
      process.exit(4);
    }
    return { roots: found, inferred: false, refused: null };
  }
  const cwd = process.cwd();
  const top = nativePath(run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).trim());
  const base = top || cwd;
  // Never infer a root at or above $HOME: a depth-6 walk of the home directory drags in
  // Library, Downloads and iCloud, costs minutes, and finds nothing worth cleaning.
  const atOrAboveHome = (p) => p === paths.home || paths.home.startsWith(p + path.sep);
  const cand = [...new Set([path.dirname(base), base])].filter((p) => !atOrAboveHome(p) && existsSync(p));
  if (!cand.length) {
    warn(`no project scan: ${base.replace(paths.home, '~')} is at or above your home directory. `
      + `Set roots with: chaff config --set=roots=~/code`);
    return { roots: [], inferred: true, refused: base };
  }
  return { roots: cand, inferred: true, refused: null };
}

/** Project roots under `roots`: anything carrying a project marker. node_modules is pruned. */
export function discoverProjects(roots, maxDepth) {
  const markers = new Map(); // root -> Set of marker names
  for (const root of roots) {
    const nameArgs = [];
    PROJECT_MARKERS.forEach((m, i) => { if (i) nameArgs.push('-o'); nameArgs.push('-name', m); });
    const out = IS_WIN ? walkProjectMarkers(root, maxDepth).join('\n') : run('find', [
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
    // Literal: directory names are not globs, and a name starting with ':' is not pathspec magic.
    const out = run('git', ['--literal-pathspecs', '-C', root, 'ls-files', '-z', '--', ...rels], { timeout: 30_000 });
    if (!out) continue;
    const files = out.split('\0').filter(Boolean);
    batch.forEach((a, j) => {
      const rel = rels[j].split(path.sep).join('/');
      if (files.some((f) => f === rel || f.startsWith(rel + '/'))) a.tracked = true;
    });
  }
}

/** All regenerable artifact dirs under `roots`, in one pass. */
export function discoverArtifacts(roots, maxDepth, includeOutputs) {
  const names = includeOutputs ? ARTIFACT_NAMES : ARTIFACT_NAMES.filter((n) => ARTIFACTS[n].category === 'cache');
  const nameArgs = [];
  names.forEach((n, i) => { if (i) nameArgs.push('-o'); nameArgs.push('-name', n); });
  const hits = [];
  for (const root of roots) {
    const out = IS_WIN ? walkArtifacts(root, maxDepth, names).join('\n') : run('find', [
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
export function discoverDeps(roots, maxDepth) {
  const hits = [];
  for (const root of roots) {
    const out = IS_WIN ? walkDeps(root, maxDepth).join('\n')
      : run('find', [root, '-maxdepth', String(maxDepth), '-type', 'd', '-name', 'node_modules', '-print', '-prune'],
        { timeout: 240_000 });
    for (const line of out.split('\n')) if (line.trim()) hits.push(line.trim());
  }
  return hits;
}
