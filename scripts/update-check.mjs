#!/usr/bin/env node
/**
 * "Is there a newer chaff?" — asked at most once a day, never inline. The statusline and the
 * SessionStart hook only ever read the cached answer; the one network call runs detached
 * (`node update-check.mjs --refresh`), with a short timeout, and any failure just means no
 * notice. Off with `updateCheck: false` in config, CHAFF_NO_UPDATE_CHECK=1, NO_UPDATE_NOTIFIER,
 * or in CI.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAFF_HOME = process.env.CHAFF_HOME || path.join(homedir(), '.chaff');
const STATE = path.join(CHAFF_HOME, 'update-check.json');
const PKG = '@gulsahsarsilmaz/chaff';
const REGISTRY = process.env.CHAFF_REGISTRY || 'https://registry.npmjs.org';
export const CHECK_EVERY_SEC = 24 * 3600;

export function installedVersion() {
  try { return JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

export function updateCheckEnabled(cfg = {}) {
  const env = process.env;
  return cfg.updateCheck !== false && !env.CHAFF_NO_UPDATE_CHECK && !env.NO_UPDATE_NOTIFIER
    && !(env.CI && env.CI !== 'false' && env.CI !== '0');
}

/** x.y.z only. A prerelease or anything unparsable is never "newer": no notice beats a wrong one. */
const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim()) || []).slice(1).map(Number);
export function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(next) {
  try { mkdirSync(CHAFF_HOME, { recursive: true }); writeFileSync(STATE, JSON.stringify(next)); } catch { /* best effort */ }
}

/** The cached answer, or null. Never touches the network. */
export function availableUpdate({ current = installedVersion(), cfg = {} } = {}) {
  if (!updateCheckEnabled(cfg) || !current) return null;
  const { latest } = readState();
  return isNewer(latest, current) ? { current, latest } : null;
}

/** Start a detached refresh when the cached answer is older than a day. Returns immediately. */
export function refreshInBackground({ cfg = {}, now = Date.now() } = {}) {
  if (!updateCheckEnabled(cfg)) return false;
  const { checkedAt = 0 } = readState();
  if (now - checkedAt >= 0 && (now - checkedAt) / 1000 < CHECK_EVERY_SEC) return false;
  // Claim the slot first, so concurrent sessions do not all fetch at once.
  writeState({ ...readState(), checkedAt: now });
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

/** The network call itself: GET /<pkg>/latest, 5 s timeout, cache the version. */
export async function refreshNow({ now = Date.now() } = {}) {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(PKG)}/latest`,
      { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const { version } = await res.json();
    if (!parse(version).length) return null;
    writeState({ ...readState(), checkedAt: now, latest: version });
    return version;
  } catch { return null; }
}

/** How this copy was installed, from where it is running. */
export function installKind(dir = HERE, env = process.env) {
  const p = dir.split(path.sep).join('/');
  if (env.CLAUDE_PLUGIN_ROOT || p.includes('/.claude/plugins/')) return 'plugin';
  if (p.includes('/Cellar/') || p.includes('/homebrew/') || p.includes('/linuxbrew/')) return 'brew';
  if (p.includes('/_npx/')) return 'npx';
  return 'npm';
}

export const UPDATE_HOW = {
  // Claude Code has no single "/plugin update" slash command: refresh the marketplace, update
  // from the Installed tab (or the shell), then reload. No restart needed.
  plugin: '/plugin marketplace update chaff, then /plugin → Installed → chaff → Update now '
    + '(or `claude plugin update chaff@chaff` in a terminal), then /reload-plugins',
  brew: 'brew upgrade chaff',
  npm: `npm install -g ${PKG}@latest`,
  npx: `npx ${PKG}@latest`,
};

/** "chaff 0.3.4 is available (you have 0.3.3). Update: …" or null. */
export function updateNotice(opts = {}) {
  const u = availableUpdate(opts);
  if (!u) return null;
  return `chaff ${u.latest} is available (you have ${u.current}). Update: ${UPDATE_HOW[opts.kind || installKind()]}`;
}

/** Notify once per version, so a session-start notice is not repeated every session. */
export function claimNotice(version) {
  const s = readState();
  if (s.notified === version) return false;
  writeState({ ...s, notified: version });
  return true;
}

const self = (() => { try { return pathToFileURL(process.argv[1] || '').href === import.meta.url; } catch { return false; } })();
if (self && process.argv.includes('--refresh')) { await refreshNow(); process.exit(0); }
