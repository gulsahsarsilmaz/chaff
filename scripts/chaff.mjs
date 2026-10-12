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
 *
 * This file is the entry point and the public module surface (tests import from here); the
 * code lives in lib/:
 *
 *   paths, exec       where state lives, running commands      (node only)
 *   catalog, config   detectors as data; config.json
 *   platform/windows  the scan layer where find/du/df/ps do not exist
 *   discover, sizes, processes, git → scan       the inventory
 *   plan → apply, trash                          deciding, then acting
 *   render/*, schedule, cli                      what the person sees and types
 *
 * Imports point down that list; nothing in lib/ imports this file.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main } from './lib/cli.mjs';

export { DEFAULTS, parseListValue } from './lib/config.mjs';
export { LockedError, __setRenameForTests, moveByCopy, removeTree, trashList, trashPath, trashPurge, trashRestore, trashSlug, treeDiff } from './lib/trash.mjs';
export { STORE_SIZE_TTL_SEC, dirSizesMb, storeSizesMb } from './lib/sizes.mjs';
export { acquireLock, releaseLock, scanInProgress } from './lib/scan.mjs';
export { applyPlan, sameProcess, sameWinProcess, winCommand, winProcInfo } from './lib/apply.mjs';
export { buildPlan } from './lib/plan.mjs';
export { classify } from './lib/catalog.mjs';
export { defaultBranchFor, isDirty, mergedBranches } from './lib/git.mjs';
export { etimeToSeconds, projectFromCmd, withinRoots } from './lib/processes.mjs';
export { markTracked, resolveRoots } from './lib/discover.mjs';
export { projectFromWinCmd, treeBytes, walkArtifacts, walkDeps, walkProjectMarkers } from './lib/platform/windows.mjs';
export { renderDoctor } from './lib/render/doctor.mjs';
export { renderExplain, renderScan, renderTiles } from './lib/render/status.mjs';
export { renderPlan } from './lib/render/plan.mjs';
export { renderStatusline } from './lib/render/statusline.mjs';
export { renderTop } from './lib/render/top.mjs';
export { renderWorktrees } from './lib/render/worktrees.mjs';
export { schtasksSpec } from './lib/schedule.mjs';

// Run the CLI only when invoked directly, so tests can import the pure functions.
// npm installs the bin as a symlink (global installs and npx alike), and Node resolves the
// main module through it while argv[1] keeps the link's path — compared raw, they never
// matched and `chaff` exited 0 having done nothing. Compare real paths.
const realArgv1 = () => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } };
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realArgv1()).href;
if (invokedDirectly) main();
