/**
 * Where chaff keeps its state, and which platform it is on. One layout for the CLI, the
 * hooks and the update check, which used to each build their own copy of these paths.
 *
 * Paths are getters, read from the environment on every use rather than once at load: tests
 * point CHAFF_HOME and HOME at a temp dir before loading chaff, and a module that captured
 * them at import would keep pointing wherever the first importer found them.
 */
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
// Runners set CI=true almost universally. There, disk is billed and a job that dies at 95%
// because the volume filled costs real money, so chaff defaults to terse, parseable output.
export const IS_CI = !!process.env.CI && process.env.CI !== 'false';

const inHome = (name) => path.join(paths.chaffHome, name);

export const paths = {
  get home() { return homedir(); },
  get chaffHome() { return process.env.CHAFF_HOME || path.join(homedir(), '.chaff'); },
  get xdgCache() { return process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'); },
  get config() { return inHome('config.json'); },
  get scanCache() { return inHome('scan-cache.json'); },
  get lock() { return inHome('scan.lock'); },
  // node_modules only changes on install, and measuring it is slow. Keep it in its own
  // longer-lived cache so an ordinary fast scan never destroys a measurement that took
  // two minutes to produce.
  get depsCache() { return inHome('deps-cache.json'); },
  get sizeCache() { return inHome('size-cache.json'); },
  get trash() { return inHome('trash'); },
  get updateCheck() { return inHome('update-check.json'); },
  get nightlyLog() { return inHome('nightly.log'); },
  get rootsNudged() { return inHome('roots-nudged'); },
  get statuslineNudged() { return inHome('statusline-nudged'); },
};

/** git and Windows command lines spell paths `C:/x`; everything chaff compares is native. */
export const nativePath = (p) => (p && path.sep === '\\' ? path.win32.normalize(p) : p);

export const userName = () => { try { return userInfo().username; } catch { return process.env.USER || ''; } };

/** First path in the list that exists, or '' — lets one entry cover several platforms. */
export const firstExisting = (candidates) => candidates.find((p) => { try { return existsSync(p); } catch { return false; } }) || '';

/** `~/code` → `/home/me/code`. Everything else is returned as given. */
export const expand = (p) => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
