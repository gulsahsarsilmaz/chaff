/**
 * Running other programs, and talking to the person while chaff works. Nothing here knows
 * what a project or an artifact is.
 */
import { execFileSync } from 'node:child_process';

/** stdout of a command, or '' when it is missing, fails or times out. Never throws. */
export function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout ?? 60_000,
      killSignal: 'SIGKILL', ...opts,
    });
  } catch { return ''; }
}

/** Whether a pid is running (and visible to us). */
export const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export const warn = (m) => process.stderr.write(`chaff: ${m}\n`);

// ── progress ─────────────────────────────────────────────────────────────────
// A full scan can walk a very large tree. Silence for two minutes reads as a hang, so say
// what is happening — on stderr, so stdout stays pipeable, and only on a real terminal.
let PROGRESS_ON = false;
let progressLast = 0;
const progressEnabled = () => PROGRESS_ON && process.stderr.isTTY;

export function setProgress(on) { PROGRESS_ON = on; }

export function progress(msg) {
  if (!progressEnabled()) return;
  const line = `  ${msg}`.padEnd(Math.max(0, (process.stderr.columns || 80) - 1)).slice(0, (process.stderr.columns || 80) - 1);
  process.stderr.write(`\r${line}`);
  progressLast = Date.now();
}

export function progressDone() {
  if (!progressEnabled() || !progressLast) return;
  process.stderr.write('\r' + ' '.repeat((process.stderr.columns || 80) - 1) + '\r');
  progressLast = 0;
}
