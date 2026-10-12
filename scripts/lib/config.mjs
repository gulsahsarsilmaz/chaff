/**
 * Reading and writing ~/.chaff/config.json. Only what the user set is ever written back:
 * saving the merged config would pin every default there for good.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { progress, warn } from './exec.mjs';
import { paths } from './paths.mjs';
import { defaultThresholds } from '../thresholds.mjs';

// ── config ────────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  roots: [],
  policy: 'propose',            // 'propose' | 'auto-orphans' | 'auto-threshold'
  thresholds: defaultThresholds(),  // scripts/thresholds.mjs, shared with the hooks
  staleArtifactDays: 7,         // an artifact untouched this long is cold, whatever its repo is doing
  staleWorktreeDays: 7,
  idleDaemonMinutes: 90,
  abandonedWorkHours: 24,       // a build/dev-server older than this is abandoned, not in flight
  maxScanDepth: 6,              // depth for finding project roots
  maxArtifactDepth: 8,          // depth for finding build artifacts
  scanTtlSeconds: 20,
  includeOutputs: true,         // also track dist/build/.next, not just caches
  sizeMode: 'fast',             // 'fast' = named artifacts only | 'full' = + node_modules
  trash: true,                  // move deletions to ~/.chaff/trash instead of unlinking
  trashTtlDays: 7,              // purge trashed entries older than this
  progress: true,               // show scan progress on stderr when attached to a terminal
  statuslineStyle: 'color',     // 'color' = ANSI red/green text | 'dots' = emoji | 'plain' = no markers
  protect: [],
  autoStatusline: true,         // the Claude Code plugin installs chaff's statusline when there is none
};

/** Only what the user set, as stored. Never write defaults back: they would freeze there. */
export function readUserConfig() {
  if (!existsSync(paths.config)) return {};
  try {
    const user = JSON.parse(readFileSync(paths.config, 'utf8'));
    return user && typeof user === 'object' && !Array.isArray(user) ? user : {};
  } catch (e) { warn(`config at ${paths.config} is not valid JSON (${e.message}); using defaults`); return {}; }
}

export function loadConfig() {
  let user = readUserConfig();
  // staleProjectDays measured the repo's commit recency; staleArtifactDays measures the
  // artifact's own. Honour the old key so an existing config keeps working.
  if (user.staleProjectDays != null && user.staleArtifactDays == null) {
    user = { ...user, staleArtifactDays: user.staleProjectDays };
  }
  // A hand-edited config is the likeliest malformed input chaff sees. A string where a list
  // belongs used to throw deep inside a scan; take a lone string as a one-item list, and drop
  // anything else with a warning rather than guess.
  for (const key of ['roots', 'protect']) {
    if (user[key] == null || Array.isArray(user[key])) continue;
    if (typeof user[key] === 'string') user = { ...user, [key]: [user[key]] };
    else { warn(`config "${key}" must be a list of paths; ignoring it`); user = { ...user, [key]: DEFAULTS[key] }; }
  }
  for (const key of ['roots', 'protect']) {
    if (Array.isArray(user[key]) && user[key].some((x) => typeof x !== 'string' || !x)) {
      warn(`config "${key}" may only hold non-empty paths; ignoring the rest`);
      user = { ...user, [key]: user[key].filter((x) => typeof x === 'string' && x) };
    }
  }
  return { ...DEFAULTS, ...user, thresholds: { ...DEFAULTS.thresholds, ...(user.thresholds || {}) } };
}

export function saveConfig(cfg) {
  mkdirSync(paths.chaffHome, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n');
}

export const LIST_KEYS = ['roots', 'protect'];

/**
 * The value of `config --set=roots=…`. Shells mangle the JSON form before chaff sees it: zsh
 * refuses an unquoted `["~/code"]` as a failed glob, and bash passes it through with the
 * quotes stripped, as `[~/code]`. Take JSON when it parses, and otherwise a comma-separated
 * list, brackets and quotes optional, so `roots=~/code,~/work` works in any shell.
 */
export function parseListValue(v) {
  if (v.startsWith('[')) { try { const a = JSON.parse(v); if (Array.isArray(a)) return a; } catch { /* fall through */ } }
  return v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}
