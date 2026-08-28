#!/usr/bin/env node
/**
 * SessionStart hook. Never scans inline — it reads the cached scan and, when that is
 * missing or stale, kicks off a detached refresh for next time. Session start is never
 * blocked on a filesystem walk.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAFF_HOME = process.env.CHAFF_HOME || path.join(homedir(), '.chaff');
const CACHE = path.join(CHAFF_HOME, 'scan-cache.json');
const CONFIG = path.join(CHAFF_HOME, 'config.json');
const NUDGE = path.join(CHAFF_HOME, 'roots-nudged');
const MAX_AGE_SEC = 900;

const emit = (ctx) => {
  if (ctx) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
  process.exit(0);
};

const refresh = (args) => {
  try { spawn(process.execPath, [path.join(HERE, 'chaff.mjs'), ...args], { detached: true, stdio: 'ignore' }).unref(); }
  catch { /* best effort */ }
};

let cfg = {};
try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { /* defaults */ }
const policy = cfg.policy || 'propose';

/**
 * With no config file the scan scope is inferred from wherever the session happened to
 * start, which can silently miss most of a machine. Say so exactly once, then never again:
 * chaff's contract is that it does not nag.
 */
const rootsNudge = (s) => {
  if (existsSync(CONFIG) || existsSync(NUDGE)) return '';
  try { mkdirSync(CHAFF_HOME, { recursive: true }); writeFileSync(NUDGE, new Date().toISOString()); }
  catch { return ''; }               // cannot record it — better silent than every session
  const where = s?.roots?.length ? `it is currently inferring ${s.roots.join(' and ')} from the cwd`
    : 'it currently has no project scope at all';
  return ` chaff has no configured roots, so ${where}, which may miss projects elsewhere on `
    + 'this machine. Ask the user once which directories hold their repos and offer to set them '
    + 'with /chaff:config roots=["~/code"]. This note is shown only once.';
};

if (!existsSync(CACHE)) { refresh(['scan', '--fresh']); emit(rootsNudge(null).trim() || null); }

let s;
try { s = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { refresh(['scan', '--fresh']); emit(null); }
if (s.schema !== 2) { refresh(['scan', '--fresh']); emit(null); }

const ageSec = (Date.now() - new Date(s.scannedAt).getTime()) / 1000;
if (ageSec > MAX_AGE_SEC) refresh(['scan', '--fresh']);

const t = { nodeRssMb: 4096, daemons: 4, diskFreeGb: 60, cacheGb: 3, worktrees: 25, storeGb: 10, ...(cfg.thresholds || {}) };
const b = [];
if (s.totals.nodeRssMb > t.nodeRssMb) b.push(`${(s.totals.nodeRssMb / 1024).toFixed(1)}GB of toolchain memory across ${s.totals.nodeProcs} processes`);
if (s.totals.daemons > t.daemons) b.push(`${s.totals.daemons} build daemons running`);
if (s.disk.freeGb < t.diskFreeGb) b.push(`only ${s.disk.freeGb}GB disk free`);
if ((s.totals.cacheMb + s.totals.outputMb) / 1024 > t.cacheGb) b.push(`${((s.totals.cacheMb + s.totals.outputMb) / 1024).toFixed(1)}GB of build cache and output`);
if (s.totals.worktrees > t.worktrees) b.push(`${s.totals.worktrees} git worktrees`);
if (!b.length) emit(rootsNudge(s).trim() || null);

if (policy === 'auto-orphans' || policy === 'auto-threshold') {
  refresh(['apply', `--tier=${policy === 'auto-threshold' ? 2 : 1}`, '--yes', '--fresh']);
}

emit(
  `chaff (scan ${Math.round(ageSec / 60)}m old): ${b.join('; ')}. Policy is "${policy}". ` +
  `If the user reports slowness, a stuck machine, or disk pressure, suggest /chaff:status for the ` +
  `breakdown or /chaff:clean to reclaim. Do not run cleanup unprompted.` + rootsNudge(s)
);
