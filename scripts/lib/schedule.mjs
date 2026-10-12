/**
 * Unattended nightly cleanup: launchd on macOS, cron on Linux, Task Scheduler on Windows.
 * Only tiers 1 and 2 can be scheduled.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { IS_MAC, IS_WIN, paths } from './paths.mjs';

export const PLIST_LABEL = 'tools.chaff.nightly';
export const plistPath = () => path.join(paths.home, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

export function scheduleArgs(tier) {
  return [process.execPath, process.argv[1], 'clean', `--tier=${tier}`, '--yes', '--fresh'];
}

/**
 * A per-user daily task (schtasks ships with Windows; no admin rights needed). The task runs
 * a small .cmd in chaff's home rather than the command itself: /TR is capped at 261
 * characters, which a node path plus a script path can exceed, and cmd.exe is what gives the
 * task a log via `>>`. cmd.exe expands `%` and ends strings at `"`, so a path containing
 * either is refused rather than escaped.
 */
export function schtasksSpec(hour, tier, { exe, script, log, home }) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`--hour must be 0-23, got ${hour}`);
  if (!Number.isInteger(tier) || tier < 1 || tier > 2) throw new Error(`only tier 1 or 2 can be scheduled, got ${tier}`);
  for (const p of [exe, script, log, home]) {
    if (/["%\r\n]/.test(p)) throw new Error(`cannot schedule from a path containing " or %: ${p}`);
  }
  const wrapper = path.win32.join(home, 'nightly.cmd');
  const wrapperBody = `@echo off\r\n"${exe}" "${script}" clean --tier=${tier} --yes --fresh >> "${log}" 2>&1\r\n`;
  return {
    wrapper, wrapperBody,
    args: ['/Create', '/F', '/SC', 'DAILY', '/TN', PLIST_LABEL, '/ST', `${String(hour).padStart(2, '0')}:00`, '/TR', `"${wrapper}"`],
  };
}
export const CRON_MARK = '# chaff nightly cleanup';

export function scheduleInstall(hour, tier) {
  mkdirSync(paths.chaffHome, { recursive: true });
  const [exe, ...rest] = scheduleArgs(tier);
  const log = paths.nightlyLog;

  if (IS_WIN) {
    let spec;
    try { spec = schtasksSpec(hour, tier, { exe, script: rest[0], log, home: paths.chaffHome }); }
    catch (e) { return { via: 'schtasks', entry: PLIST_LABEL, log, err: e.message }; }
    try {
      writeFileSync(spec.wrapper, spec.wrapperBody);
      execFileSync('schtasks', spec.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      return { via: 'schtasks', entry: `${PLIST_LABEL} → ${spec.wrapper}`, log, err: null };
    } catch (e) { return { via: 'schtasks', entry: PLIST_LABEL, log, err: e.stderr?.toString() || e.message }; }
  }

  if (!IS_MAC) {
    // crontab is the one scheduler present on effectively every Linux box.
    const line = `0 ${hour} * * * ${exe} ${rest.join(' ')} >> ${log} 2>&1  ${CRON_MARK}`;
    const current = run('crontab', ['-l']).split('\n').filter((l) => l && !l.includes(CRON_MARK));
    const next = [...current, line].join('\n') + '\n';
    try {
      execFileSync('crontab', ['-'], { input: next, stdio: ['pipe', 'ignore', 'pipe'] });
      return { via: 'cron', entry: line, log, err: null };
    } catch (e) { return { via: 'cron', entry: line, log, err: e.stderr?.toString() || e.message }; }
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[exe, ...rest].map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), plist);
  run('launchctl', ['unload', plistPath()]);
  try {
    execFileSync('launchctl', ['load', plistPath()], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    return { via: 'launchd', entry: plistPath(), log, err: null };
  } catch (e) { return { via: 'launchd', entry: plistPath(), log, err: e.stderr || e.message }; }
}

export function scheduleStatus() {
  if (IS_WIN) {
    const out = run('schtasks', ['/Query', '/TN', PLIST_LABEL]);
    const found = out.includes(PLIST_LABEL);
    return { via: 'schtasks', installed: found, loaded: found, entry: PLIST_LABEL, log: paths.nightlyLog };
  }
  if (!IS_MAC) {
    const line = run('crontab', ['-l']).split('\n').find((l) => l.includes(CRON_MARK));
    return { via: 'cron', installed: !!line, loaded: !!line, entry: line || '(none)', log: paths.nightlyLog };
  }
  return {
    via: 'launchd', installed: existsSync(plistPath()),
    loaded: run('launchctl', ['list']).split('\n').some((l) => l.includes(PLIST_LABEL)),
    entry: plistPath(), log: paths.nightlyLog,
  };
}

export function scheduleRemove() {
  if (IS_WIN) {
    rmSync(path.join(paths.chaffHome, 'nightly.cmd'), { force: true });
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', PLIST_LABEL], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  if (!IS_MAC) {
    const kept = run('crontab', ['-l']).split('\n').filter((l) => l && !l.includes(CRON_MARK));
    try { execFileSync('crontab', ['-'], { input: kept.join('\n') + '\n', stdio: ['pipe', 'ignore', 'ignore'] }); return true; }
    catch { return false; }
  }
  run('launchctl', ['unload', plistPath()]);
  try { unlinkSync(plistPath()); return true; } catch { return false; }
}
