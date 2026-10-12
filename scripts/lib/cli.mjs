/**
 * The command line: argument parsing, the help text, and one handler per subcommand.
 * scripts/chaff.mjs is only the entry point that calls `main()`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlan } from './apply.mjs';
import { LIST_KEYS, loadConfig, parseListValue, readUserConfig, saveConfig } from './config.mjs';
import { run, setProgress, warn } from './exec.mjs';
import { IS_CI, paths } from './paths.mjs';
import { buildPlan } from './plan.mjs';
import { renderDoctor } from './render/doctor.mjs';
import { ANSI, gb, termWidth } from './render/format.mjs';
import { renderPlan } from './render/plan.mjs';
import { renderScan } from './render/status.mjs';
import { renderStatusline } from './render/statusline.mjs';
import { renderTop } from './render/top.mjs';
import { renderWorktrees } from './render/worktrees.mjs';
import { cachedScan, diskFor, readCache, scan, scanInProgress, writeCache } from './scan.mjs';
import { scheduleInstall, scheduleRemove, scheduleStatus } from './schedule.mjs';
import { trashList, trashPurge, trashRestore } from './trash.mjs';
import { planDigest } from '../plan-digest.mjs';
import { GLOBAL_COMMAND, ensureStatusline, removeStatusline, statuslineCommand } from '../statusline-setup.mjs';
import { availableUpdate, installedVersion, refreshInBackground, updateNotice } from '../update-check.mjs';

export const HELP = `
  chaff — separate the live work from the dead weight on a developer machine

  SEEING WHAT IS THERE                                              (never changes anything)
    chaff status                  live pressure + per-project breakdown
    chaff plan                    what it would clean, sorted by safety tier
    chaff statusline              one-line summary for your editor statusline
    chaff top                     processes by memory, attributed to a project
    chaff doctor                  what is wrong and what to do about it
    chaff worktrees [--dirty]     every worktree, with what is uncommitted in it

  RECLAIMING SPACE
    chaff reap                    tier 1 only — provably dead. Safe, no prompt.
    chaff clean --tier=2 --yes    + idle daemons, stale caches, stale build output
    chaff clean --tier=3 --yes --force
                                  + live daemons, active build output, stale worktrees

  SEEING FIRST, THEN ACTING
    chaff clean --tier=2 --dry-run    print the exact list, change nothing

  CONFIG
    chaff version                         installed version, and how to update if newer
    chaff config                          show current settings
    chaff config --set=policy=propose     propose | auto-orphans | auto-threshold
    chaff config --set=roots=~/code,~/work  directories to scan

  UNATTENDED
    chaff schedule                        show nightly-cleanup status
    chaff schedule --install --hour=3     run tier 2 nightly at 03:00
    chaff schedule --uninstall            stop it

  CI RUNNERS
    chaff ci                      clean tier 2, print a one-line report, exit 0
    chaff ci --strict             exit 1 when still below the disk floor
    chaff ci --json --tier=1      machine-readable, provably-dead only

  AGENTS (MCP)
    chaff mcp                     serve over stdio for Codex, Cursor, Zed, Claude Code
                                  read-only tools plus tier 1-2 cleanup; tier 3 is CLI-only

  UNDO
    chaff trash                   what was removed and can still be restored
    chaff restore <id>            put one back
    chaff trash --empty           purge now (otherwise auto-purged after trashTtlDays)

  TIERS
    1  dead   the project/worktree/process it belongs to is gone.  Costs you nothing.
    2  idle   nothing running, nothing touched it recently.        Costs a cold rebuild.
    3  live   running tasks, active builds, uncommitted work.      Costs real work.
              Entries marked [locked] [in use] [building] are never executed, even --force.

  FLAGS
    --json        machine-readable      --fresh     bypass the 20s scan cache
    --dry-run     show, do not act      --deep      also size node_modules, re-size stores
    --tier=N      how far to go         --yes       required for tier 2
    --full        include node_modules  --dirty     worktrees: only unclean ones
    --force       required for tier 3   --stale=N   statusline rescan window (seconds)
    --plain       statusline: no ANSI, for tmux / starship / a bare prompt
    --explain     append a legend to status: what each metric means and what trips it

  ECOSYSTEMS
    JS/TS     nx turbo next vite angular parcel rollup rspack webpack expo storybook
    Rust      target/ (gated on Cargo.toml), cargo registry
    .NET      obj/ (gated on *.csproj/*.sln), nuget packages
    Go        module cache, build cache
    JVM       .gradle/, target/ (gated on pom.xml), gradle + maven caches
    Python    __pycache__ .pytest_cache .mypy_cache .ruff_cache .tox, pip cache
    Unity     Library/ Temp/          (gated on ProjectSettings + Assets)
    Unreal    Intermediate/ DerivedDataCache/ Binaries/  (gated on *.uproject)

  In Claude Code:  /chaff:status  /chaff:plan  /chaff:clean  /chaff:reap  /chaff:config
`;

// ── cli ───────────────────────────────────────────────────────────────────────

export const SUBCOMMANDS = new Set(['scan', 'status', 'plan', 'top', 'doctor', 'worktrees', 'wt', 'statusline',
  'schedule', 'trash', 'restore', 'apply', 'clean', 'reap', 'ci', 'config', 'mcp', 'help', 'version']);

/** `--set=key=[...]`: a malformed value is the user's typo, so say so instead of a stack trace. */
export function parseJsonValue(k, v) {
  try { return JSON.parse(v); } catch (e) {
    process.stderr.write(`chaff: --set=${k}: not valid JSON (${e.message}). Quote it, e.g. --set=${k}='[1,2]'\n`);
    process.exit(2);
  }
}

export function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'scan';
  // A typo must fail at once: falling through to the end meant a full scan first, and on
  // Windows the "cleanup not enabled" refusal, before "unknown subcommand".
  if (!SUBCOMMANDS.has(sub)) { process.stderr.write(`chaff: unknown subcommand: ${sub}\n\n${HELP}`); process.exit(1); }
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
  // `+'all'` is NaN, and every `tier >= 2` guard is false for NaN while `a.tier > NaN` lets
  // every action through — so a typo skipped --yes and --force and ran tier 3. Reject it.
  const tierArg = (d) => {
    const v = val('tier', d);
    if (!/^[123]$/.test(v)) { process.stderr.write(`chaff: --tier must be 1, 2 or 3 (got "${v}")\n`); process.exit(2); }
    return +v;
  };
  // Before anything scans or acts: a bad tier must fail fast, not after a 20s scan.
  if (argv.some((x) => x.startsWith('--tier='))) tierArg('1');
  const cfg = loadConfig();
  const json = flag('json');

  if (sub === 'help' || flag('help') || flag('h')) { process.stdout.write(HELP); return; }

  if (sub === 'version' || flag('version') || flag('v')) {
    process.stdout.write(`chaff ${installedVersion() || 'unknown'}\n`);
    const note = updateNotice({ cfg });
    if (note) process.stdout.write(note + '\n');
    refreshInBackground({ cfg });
    return;
  }

  if (sub === 'config') {
    const set = val('set');
    if (set) {
      const [k, ...rest] = set.split('=');
      const v = rest.join('=');
      const parsed = LIST_KEYS.includes(k) ? parseListValue(v)
        : v === 'true' ? true : v === 'false' ? false
        : /^-?\d+(\.\d+)?$/.test(v) ? +v : v.startsWith('[') ? parseJsonValue(k, v) : v;
      // Merge into what the user set, not the merged config: saving defaults would pin them
      // (the RAM-scaled nodeRssMb among them) so a later default never reached this user.
      const next = readUserConfig();
      if (k.includes('.')) { const [a, b] = k.split('.'); next[a] = { ...(next[a] || {}), [b]: parsed }; }
      else next[k] = parsed;
      saveConfig(next);
      process.stdout.write(`set ${k} = ${JSON.stringify(parsed)}  (${paths.config})\n`);
      return;
    }
    process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
    return;
  }

  if (sub === 'mcp') {
    // Serve MCP over stdio, so Codex, Cursor, Zed and anything else that speaks the protocol
    // gets the same tools. Loading it hands stdin/stdout to the JSON-RPC channel, so nothing
    // else may write to them — no progress, no warnings, no banner.
    import('../mcp.mjs');
    return;
  }

  // On native Windows only reporting runs past this point. help/config/mcp returned above.

  // Progress goes to stderr and only on a terminal; --json and --quiet suppress it.
  setProgress(cfg.progress !== false && !json && !IS_CI && !flag('quiet'));

  if (sub === 'ci') {
    // One shot for a runner: reclaim what is provably safe, then report. Exits non-zero
    // when the volume is still under the floor, so a pipeline can fail loudly and early
    // rather than halfway through a build.
    // ci deletes outright — no trash, no prompt — which is right on a throwaway runner and
    // wrong on a laptop where someone typed it to see what it does.
    if (!IS_CI && !flag('yes') && !flag('dry-run')) {
      process.stderr.write('chaff ci deletes without the trash and is meant for CI runners (CI is not set).\n'
        + '  Pass --yes to run it here anyway, or --dry-run to see what it would do.\n');
      process.exit(2);
    }
    setProgress(false);
    const scanned = scan(cfg, {}) || readCache();
    if (!scanned) { process.stdout.write('chaff: no scan available\n'); process.exit(3); }
    writeCache(scanned);
    const cplan = buildPlan(scanned, cfg);
    const tier = tierArg('2');
    const results = flag('dry-run') ? [] : applyPlan(cplan, { maxTier: tier, dryRun: false, useTrash: false });
    const freed = results.filter((r) => r.status === 'done').reduce((n, r) => n + r.reclaimMb, 0);
    const after = diskFor(scanned.roots[0] || paths.home);
    const report = {
      freedGb: +(freed / 1024).toFixed(2),
      diskFreeGb: after.freeGb, diskPctUsed: after.pctUsed,
      floorGb: cfg.thresholds.diskFreeGb,
      belowFloor: after.freeGb < cfg.thresholds.diskFreeGb,
      actions: results.length,
      cacheGb: +(scanned.totals.cacheMb / 1024).toFixed(2),
      outputGb: +(scanned.totals.outputMb / 1024).toFixed(2),
      projects: scanned.totals.projects, worktrees: scanned.totals.worktrees,
    };
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(
      `chaff: freed ${report.freedGb}GB in ${report.actions} actions · ` +
      `${report.diskFreeGb}GB free (${report.diskPctUsed}% used) · ` +
      `${report.belowFloor ? `BELOW ${report.floorGb}GB floor` : 'ok'}\n`);
    process.exit(report.belowFloor && flag('strict') ? 1 : 0);
  }

  if (sub === 'trash') {
    if (flag('empty')) {
      const n = trashPurge(0);
      process.stdout.write(`  emptied trash (${n} entr${n === 1 ? 'y' : 'ies'})\n`);
      return;
    }
    const entries = trashList();
    if (json) { process.stdout.write(JSON.stringify(entries, null, 2) + '\n'); return; }
    if (!entries.length) { process.stdout.write('  trash is empty\n'); return; }
    process.stdout.write(`\n  ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · purged after ${cfg.trashTtlDays}d\n\n`);
    for (const e of entries) {
      const age = e.ageSec < 3600 ? `${Math.round(e.ageSec / 60)}m` : `${Math.round(e.ageSec / 3600)}h`;
      process.stdout.write(`  ${age.padStart(5)}  ${e.origin.replace(paths.home, '~')}\n         id: ${e.id}\n`);
    }
    process.stdout.write(`\n  chaff restore <id>    chaff trash --empty\n\n`);
    return;
  }

  if (sub === 'restore') {
    const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!id) { process.stderr.write('usage: chaff restore <id>   (see: chaff trash)\n'); process.exit(2); }
    const r = trashRestore(id);
    process.stdout.write(r.ok ? `  restored ${r.origin.replace(paths.home, '~')}\n` : `  could not restore: ${r.why}\n`);
    process.exit(r.ok ? 0 : 1);
  }

  if (sub === 'schedule') {
    if (flag('uninstall')) {
      process.stdout.write(scheduleRemove() ? '  nightly cleanup removed\n' : '  nothing scheduled\n');
      return;
    }
    if (flag('install')) {
      const hour = +val('hour', '3'), tier = tierArg('2');
      if (tier >= 3) { process.stderr.write('refusing to schedule tier 3: it can delete uncommitted work\n'); process.exit(2); }
      const r = scheduleInstall(hour, tier);
      process.stdout.write(r.err
        ? `  installing via ${r.via} failed: ${String(r.err).trim()}\n  entry: ${r.entry}\n`
        : `  nightly tier-${tier} cleanup scheduled for ${String(hour).padStart(2, '0')}:00 via ${r.via}\n  entry: ${r.entry}\n  log:   ${r.log}\n`);
      return;
    }
    const st = scheduleStatus();
    process.stdout.write(`  scheduler: ${st.via}\n  installed: ${st.installed}\n  loaded:    ${st.loaded}\n  entry:     ${st.entry}\n  log:       ${st.log}\n\n  chaff schedule --install [--hour=3] [--tier=2]\n  chaff schedule --uninstall\n`);
    return;
  }

  if (sub === 'statusline' && (flag('install') || flag('uninstall'))) {
    if (flag('uninstall')) {
      // Off for good: otherwise the plugin's next session start would put it straight back.
      saveConfig({ ...readUserConfig(), autoStatusline: false });
      let r;
      try { r = removeStatusline(); } catch (e) { r = { status: 'error', why: e.message }; }
      const say = { removed: 'chaff statusline removed', none: 'no statusline was set',
                    foreign: 'your statusline is not chaff\'s; left it alone', error: `could not edit settings: ${r.why}` };
      process.stdout.write(`  ${say[r.status]}\n  automatic setup is off (autoStatusline=false)\n`);
      process.exit(r.status === 'error' ? 1 : 0);
    }
    // The entry script, not this module: the statusline command must run scripts/chaff.mjs.
    const self = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chaff.mjs'));
    // npx runs from a cache directory that is cleared without notice; a statusline pointing
    // there would break silently some days later.
    if (self.includes(`${path.sep}_npx${path.sep}`)) {
      process.stderr.write('chaff: run this from a global install (npm i -g @gulsahsarsilmaz/chaff) or the Claude Code plugin, not npx.\n');
      process.exit(2);
    }
    saveConfig({ ...readUserConfig(), autoStatusline: true });
    // Launched through a bin on PATH (npm -g, Homebrew, nvm), write the bare command: the
    // resolved path is a versioned directory that the next upgrade deletes.
    const viaBin = path.basename(process.argv[1] || '') === 'chaff';
    const want = viaBin ? GLOBAL_COMMAND : statuslineCommand(self);
    let r;
    try { r = ensureStatusline(want); } catch (e) { r = { status: 'error', why: e.message }; }
    const say = { installed: 'chaff statusline installed', updated: 'chaff statusline repointed to this install',
                  current: 'chaff statusline already installed', error: `could not edit settings: ${r.why}`,
                  foreign: 'you already have a statusline, so it was left alone. To show chaff under it, add this\n'
                    + `  line to your statusline script:\n\n    ${want}` };
    process.stdout.write(`  ${say[r.status]}\n`);
    process.exit(r.status === 'error' ? 1 : 0);
  }

  if (sub === 'statusline') {
    // Never scan inline: the statusline runs on every keystroke-batch and must be instant.
    // Read the cache, render it, and kick off a detached refresh when it has gone stale so
    // the numbers keep moving on their own.
    const staleAfter = +val('stale', '90');
    let cached = null;
    try {
      const c = JSON.parse(readFileSync(paths.scanCache, 'utf8'));
      if (c.schema === 2) cached = c;
    } catch { /* no usable cache */ }

    const ageSec = cached ? (Date.now() - new Date(cached.scannedAt).getTime()) / 1000 : Infinity;
    // Only spawn a refresh when no scan is already running. Without this check the
    // statusline's refresh tick will stack scans on top of each other indefinitely.
    if (ageSec > staleAfter && !scanInProgress()) {
      try {
        spawn(process.execPath, [process.argv[1], 'scan', '--fresh'], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* best effort */ }
    }
    // --plain forces unstyled output for consumers that mangle raw ANSI: tmux wants its own
    // #[fg=...] syntax, and starship re-styles whatever a custom module prints.
    const scfg = flag('plain') ? { ...cfg, statuslineStyle: 'plain' } : cfg;
    if (!cached) { process.stdout.write('chaff ⏳ scanning…\n'); return; }
    // This runs in people's shell prompts and tmux status bars. A throw here — a cache written
    // by a concurrent scan, a field that moved between versions — would break their prompt on
    // every keystroke, which is far worse than showing nothing. Never let that happen.
    try {
      // A newer release shows here until it is installed; the network check behind it runs
      // detached at most once a day, so the prompt never waits on it.
      refreshInBackground({ cfg });
      const up = availableUpdate({ cfg });
      const upText = !up ? '' : scfg.statuslineStyle === 'color' ? ` ${ANSI.yellow}↑${up.latest}${ANSI.off}` : ` ↑${up.latest}`;
      process.stdout.write(renderStatusline(cached, scfg) + (ageSec > staleAfter ? ' ↻' : '') + upText + '\n');
    } catch {
      process.stdout.write('chaff ⏳\n');
    }
    return;
  }

  let s;
  if (flag('fresh')) {
    s = scan(cfg, { deep: (flag('deep') || flag('full')) });
    if (s) writeCache(s);
    else {
      s = readCache();
      if (!s) { process.stderr.write('chaff: a scan is already running; try again in a moment\n'); process.exit(3); }
      warn('a scan is already running — showing the last cached result instead');
    }
  } else {
    s = cachedScan(cfg, { deep: (flag('deep') || flag('full')) });
  }

  if (sub === 'scan' || sub === 'status') {
    // `explain` also lands as a bare word: the slash command forwards $ARGUMENTS positionally.
    const explain = flag('explain') || argv.includes('explain');
    process.stdout.write(json ? JSON.stringify(s, null, 2) + '\n'
      : renderScan(s, cfg, { width: termWidth(val('width')), explain }));
    return;
  }

  if (sub === 'top') {
    process.stdout.write(json ? JSON.stringify(s.processes, null, 2) + '\n' : renderTop(s, +val('limit', '20')));
    return;
  }

  if (sub === 'worktrees' || sub === 'wt') {
    process.stdout.write(json ? JSON.stringify(s.worktrees, null, 2) + '\n'
      : renderWorktrees(s, cfg, { dirtyOnly: flag('dirty') }));
    return;
  }

  if (sub === 'doctor') {
    const d = buildPlan(s, cfg);
    process.stdout.write(renderDoctor(s, d, cfg));
    return;
  }

  const plan = buildPlan(s, cfg);

  if (sub === 'plan') {
    process.stdout.write(json ? JSON.stringify(plan, null, 2) + '\n' : renderScan(s, cfg) + renderPlan(plan));
    return;
  }

  if (sub === 'apply' || sub === 'clean' || sub === 'reap') {
    const maxTier = sub === 'reap' ? 1 : tierArg('1');
    const dryRun = flag('dry-run');
    if (maxTier >= 2 && !flag('yes') && !dryRun) {
      process.stderr.write('refusing to apply tier 2 without --yes\n'); process.exit(2);
    }
    if (maxTier >= 3 && !flag('force') && !dryRun) {
      process.stderr.write('tier 3 touches running work or uncommitted code; pass --force to proceed\n'); process.exit(2);
    }
    // --expect binds this run to a plan someone already saw (the MCP server passes it): if
    // what would be applied now differs from what they agreed to, apply nothing.
    const expect = val('expect');
    if (expect && planDigest(plan.actions, maxTier) !== expect) {
      process.stderr.write('the plan changed since it was shown; nothing was applied. Run `chaff plan` again\n'); process.exit(2);
    }
    const useTrash = cfg.trash !== false && !flag('no-trash');
    const results = applyPlan(plan, { maxTier, dryRun, useTrash });
    if (!dryRun && useTrash) {
      const purged = trashPurge(cfg.trashTtlDays ?? 7);
      if (purged) warn(`purged ${purged} trash entr${purged === 1 ? 'y' : 'ies'} older than ${cfg.trashTtlDays ?? 7}d`);
    }
    if (json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
    for (const r of results) {
      process.stdout.write(`  ${r.status.padEnd(8)} ${r.kind.padEnd(16)} ${r.target.replace(paths.home, '~')}${r.note ? `  (${r.note})` : ''}\n`);
    }
    const done = results.filter((r) => r.status === 'done');
    const trashed = done.filter((r) => r.trash).length;
    process.stdout.write(`\n  ${done.length}/${results.length} applied · ~${gb(done.reduce((n, r) => n + r.reclaimMb, 0))}GB reclaimed\n`);
    if (trashed) process.stdout.write(`  ${trashed} moved to trash, recoverable for ${cfg.trashTtlDays ?? 7} days · chaff trash\n`);
    process.stdout.write('\n');
    return;
  }

  process.stderr.write(`unknown subcommand: ${sub}\n${HELP}`);
  process.exit(1);
}
