/**
 * Puts chaff's statusline into Claude Code's user settings, so nobody has to.
 *
 * A plugin cannot ship a statusline: Claude Code drops every plugin settings key except
 * `agent` and `subagentStatusLine`. So the SessionStart hook calls this instead, and the
 * rules are what make that acceptable:
 *
 *   - no statusline yet       → install chaff's
 *   - chaff's, at a stale path → repoint it (plugin updates move the install directory)
 *   - anyone else's           → never touched; the caller tells the user how to chain
 *   - unparseable settings    → never touched; a rewrite would lose whatever is in there
 *
 * Kept free of chaff.mjs imports: it runs on every session start and must stay instant.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const settingsPath = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'settings.json');

/**
 * The only two commands chaff ever writes. Anything else — a user's script that calls chaff,
 * chaff with their own flags — is theirs, and is never repointed or removed.
 */
export const GLOBAL_COMMAND = 'chaff statusline --stale=300';
const PLUGIN_SHAPE = /^node "[^"$`\\]*\/chaff\.mjs" statusline --stale=300$/;
export const isChaffStatusline = (cmd) => cmd === GLOBAL_COMMAND || (typeof cmd === 'string' && PLUGIN_SHAPE.test(cmd));

/** `node "<script>" statusline --stale=300`, or null for a path the shell would reinterpret. */
export const statuslineCommand = (script) => (/["$`\\]/.test(script) ? null : `node "${script}" statusline --stale=300`);

function readSettings(file) {
  if (!existsSync(file)) return { settings: {} };
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { error: `${file} is not a JSON object` };
    return { settings };
  } catch (e) { return { error: `${file} is not valid JSON (${e.message})` }; }
}

/**
 * Write via a sibling temp file and a rename, so a crash never leaves half a settings file.
 * Through a symlink (dotfile managers link settings.json from a repo), write the target:
 * renaming over the link would silently replace it with a plain file.
 */
function writeSettings(file, settings) {
  try { file = realpathSync(file); } catch { /* new file */ }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.chaff-${process.pid}.tmp`;
  let mode;
  try { mode = statSync(file).mode & 0o777; } catch { /* new file */ }
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', mode ? { mode } : undefined);
  renameSync(tmp, file);
}

/**
 * Make sure chaff's statusline is in place, running `want` (from statuslineCommand, or
 * GLOBAL_COMMAND). A global install's command is never repointed at a plugin directory:
 * it survives plugin updates, which is why the user chose it.
 * Returns { status: 'installed' | 'updated' | 'current' | 'foreign' | 'error', why? }.
 */
export function ensureStatusline(want, file = settingsPath()) {
  if (!want) return { status: 'error', why: 'the install path contains a character the shell would reinterpret' };
  const { settings, error } = readSettings(file);
  if (error) return { status: 'error', why: error };
  const sl = settings.statusLine;
  if (!sl) {
    writeSettings(file, { ...settings, statusLine: { type: 'command', command: want, refreshInterval: 15 } });
    return { status: 'installed' };
  }
  if (!isChaffStatusline(sl.command)) return { status: 'foreign' };
  if (sl.command === want || sl.command === GLOBAL_COMMAND) return { status: 'current' };
  writeSettings(file, { ...settings, statusLine: { ...sl, command: want } });
  return { status: 'updated' };
}

/** Remove chaff's statusline. Someone else's is left exactly as it is. */
export function removeStatusline(file = settingsPath()) {
  const { settings, error } = readSettings(file);
  if (error) return { status: 'error', why: error };
  if (!settings.statusLine) return { status: 'none' };
  if (!isChaffStatusline(settings.statusLine.command)) return { status: 'foreign' };
  const { statusLine, ...rest } = settings;
  writeSettings(file, rest);
  return { status: 'removed' };
}
