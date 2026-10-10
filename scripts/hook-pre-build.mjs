#!/usr/bin/env node
/**
 * PreToolUse guard. Catches a build about to start on a machine that has no room for it,
 * so you find out now rather than halfway through a 20-minute compile.
 *
 * Reads the cached scan only — never scans, so it adds no measurable latency.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CHAFF_HOME = process.env.CHAFF_HOME || path.join(homedir(), '.chaff');
const pass = () => process.exit(0);

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { pass(); }

let evt;
try { evt = JSON.parse(input); } catch { pass(); }

const cmd = evt?.tool_input?.command || '';
if (!cmd) pass();

// Only the commands that actually consume a lot of disk.
const BUILD = /\b(nx (run|run-many|build|affected)|turbo run|pnpm (build|dlx)|npm run build|yarn build|next build|vite build|tsc -b|cargo build|xcodebuild|gradlew? assemble|expo (build|prebuild)|pod install)\b/;
if (!BUILD.test(cmd)) pass();

let cfg = {}, scan = null;
try { cfg = JSON.parse(readFileSync(path.join(CHAFF_HOME, 'config.json'), 'utf8')); } catch { /* defaults */ }
try { scan = JSON.parse(readFileSync(path.join(CHAFF_HOME, 'scan-cache.json'), 'utf8')); } catch { pass(); }
if (!scan?.disk) pass();

const floor = cfg.thresholds?.diskFreeGb ?? 60;
const free = scan.disk.freeGb;
if (free >= floor) pass();

const ageMin = Math.round((Date.now() - new Date(scan.scannedAt).getTime()) / 60000);
const critical = free < floor * 0.5;

// In an autonomous permission mode ("auto", acceptEdits, bypassPermissions) nobody is sitting
// there to answer a prompt, so an `ask` just stalls the run. Warn in the reason, never block.
const mode = evt?.permission_mode || '';
const unattended = mode !== '' && mode !== 'default' && mode !== 'plan';

const reason =
  `chaff: ${free}GB free, below your ${floor}GB floor` +
  (critical ? ' — and less than half of it.' : '.') +
  ` This build may fail partway or fill the disk.` +
  ` /chaff:plan shows what can be reclaimed; /chaff:clean 2 frees it.` +
  ` (scan ${ageMin}m old)`;

// Never return `allow`: it is not "no objection", it approves the entire command on the
// user's behalf and skips their permission prompt — `rm -rf ~/x; npm run build` included.
// Never hard-deny either: a wrong guess must not block real work. So: ask when it is dire
// and someone is watching, otherwise warn and leave the decision to the user's own rules.
const out = critical && !unattended
  ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
  : { systemMessage: reason };
process.stdout.write(JSON.stringify(out));
