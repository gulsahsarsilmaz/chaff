/**
 * The plugin writes to the user's own Claude Code settings, which is only acceptable while
 * it never clobbers anything: someone else's statusline, an unparseable file, or a choice to
 * turn it off. Every test points CLAUDE_CONFIG_DIR at a temp dir.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStatusline, removeStatusline, isChaffStatusline, statuslineCommand, GLOBAL_COMMAND } from '../scripts/statusline-setup.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const HOOK = path.join(SCRIPTS, 'hook-session-start.mjs');
const CLI = path.join(SCRIPTS, 'chaff.mjs');
const temps = [];
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'chaff-sl-')); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const env = () => {
  const claude = tmp(), home = tmp();
  // A fresh, healthy cached scan, so the hook has no reason to start a background rescan:
  // each test has its own CHAFF_HOME, so the scan lock would not stop those piling up.
  writeFileSync(path.join(home, 'scan-cache.json'), JSON.stringify({
    schema: 2, scannedAt: new Date().toISOString(), roots: ['/x'], disk: { freeGb: 999 },
    totals: { nodeRssMb: 0, nodeProcs: 0, daemons: 0, cacheMb: 0, outputMb: 0, worktrees: 0 },
  }));
  writeFileSync(path.join(home, 'roots-nudged'), 'test');
  return { claude, home, settings: path.join(claude, 'settings.json'),
           vars: { ...process.env, CLAUDE_CONFIG_DIR: claude, CHAFF_HOME: home } };
};
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const hook = (e) => spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: e.vars, timeout: 30_000 });
const cli = (e, ...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: e.vars, timeout: 30_000 });

test('session start installs the statusline when there is none, and says so', () => {
  const e = env();
  writeFileSync(e.settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }));
  const r = hook(e);
  assert.equal(r.status, 0, r.stderr);
  const s = read(e.settings);
  assert.ok(isChaffStatusline(s.statusLine.command), s.statusLine.command);
  assert.ok(s.statusLine.command.includes(CLI), 'points at this install');
  assert.equal(s.model, 'opus', 'other settings survive');
  assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /added its live machine-pressure statusline/);
});

test('session start creates settings.json when the user has none', () => {
  const e = env();
  assert.equal(hook(e).status, 0);
  assert.ok(isChaffStatusline(read(e.settings).statusLine.command));
});

test('someone else\'s statusline is never replaced, and the tip is shown once', () => {
  const e = env();
  const mine = { statusLine: { type: 'command', command: '~/bin/my-prompt.sh' } };
  writeFileSync(e.settings, JSON.stringify(mine));
  const first = hook(e);
  assert.deepEqual(read(e.settings), mine);
  assert.match(first.stdout, /already has their own Claude Code statusline/);
  const second = hook(e);
  assert.doesNotMatch(second.stdout, /already has their own/, 'not every session');
  assert.deepEqual(read(e.settings), mine);
});

test('a plugin update repoints chaff\'s statusline instead of leaving it broken', () => {
  const e = env();
  writeFileSync(e.settings, JSON.stringify({ statusLine: { type: 'command', refreshInterval: 30,
    command: 'node "/old/plugins/cache/chaff/0.2.0/scripts/chaff.mjs" statusline --stale=300' } }));
  assert.equal(hook(e).status, 0);
  const sl = read(e.settings).statusLine;
  assert.ok(sl.command.includes(CLI), sl.command);
  assert.equal(sl.refreshInterval, 30, 'the user\'s own tweaks to it survive');
});

test('an unparseable settings file is never rewritten', () => {
  const e = env();
  writeFileSync(e.settings, '{ "model": "opus", // a comment\n }');
  const before = readFileSync(e.settings, 'utf8');
  assert.equal(hook(e).status, 0, 'and the session still starts');
  assert.equal(readFileSync(e.settings, 'utf8'), before);
  assert.equal(ensureStatusline(statuslineCommand('/x/chaff.mjs'), e.settings).status, 'error');
});

test('uninstall removes it and stops the plugin from putting it back', () => {
  const e = env();
  hook(e);
  const r = cli(e, 'statusline', '--uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(e.settings).statusLine, undefined);
  hook(e);
  assert.equal(read(e.settings).statusLine, undefined, 'autoStatusline=false is respected');
  assert.equal(read(path.join(e.home, 'config.json')).autoStatusline, false);
});

test('uninstall leaves someone else\'s statusline alone', () => {
  const e = env();
  writeFileSync(e.settings, JSON.stringify({ statusLine: { type: 'command', command: 'starship prompt' } }));
  assert.equal(removeStatusline(e.settings).status, 'foreign');
  assert.equal(read(e.settings).statusLine.command, 'starship prompt');
});

test('chaff statusline --install from a checkout installs and is idempotent', () => {
  const e = env();
  assert.match(cli(e, 'statusline', '--install').stdout, /installed/);
  assert.match(cli(e, 'statusline', '--install').stdout, /already installed/);
  assert.ok(!existsSync(e.settings + '.tmp'));
});

for (const [what, command] of [
  ['a script that chains chaff', '~/my.sh; node "/p/chaff/scripts/chaff.mjs" statusline --stale=300'],
  ['chaff with flags of their own', 'node "/old/chaff/scripts/chaff.mjs" statusline --stale=600 --plain'],
]) {
  test(`${what} is the user's own statusline, never repointed`, () => {
    const e = env();
    const mine = { statusLine: { type: 'command', command } };
    writeFileSync(e.settings, JSON.stringify(mine));
    hook(e);
    assert.deepEqual(read(e.settings), mine);
    assert.equal(removeStatusline(e.settings).status, 'foreign', 'nor removed');
  });
}

test('a global install\'s statusline is never repointed at a plugin directory', () => {
  const e = env();
  writeFileSync(e.settings, JSON.stringify({ statusLine: { type: 'command', command: GLOBAL_COMMAND } }));
  hook(e);
  assert.equal(read(e.settings).statusLine.command, GLOBAL_COMMAND);
});

test('a symlinked settings.json stays a symlink, and its target is what changes', () => {
  const e = env();
  const dotfiles = tmp();
  const real = path.join(dotfiles, 'claude-settings.json');
  writeFileSync(real, JSON.stringify({ model: 'opus' }));
  symlinkSync(real, e.settings);
  assert.equal(hook(e).status, 0);
  assert.ok(lstatSync(e.settings).isSymbolicLink(), 'the link is not replaced by a plain file');
  assert.ok(isChaffStatusline(read(real).statusLine.command));
  assert.equal(read(real).model, 'opus');
});

test('an install path the shell would reinterpret is refused, not written', () => {
  assert.equal(statuslineCommand('/Users/o"neil/chaff.mjs'), null);
  assert.equal(statuslineCommand('/opt/$HOME/chaff.mjs'), null);
  const e = env();
  assert.equal(ensureStatusline(statuslineCommand('/a`b`/chaff.mjs'), e.settings).status, 'error');
  assert.ok(!existsSync(e.settings));
});

test('launched through a bin named chaff, --install writes the bare command that survives upgrades', () => {
  const e = env();
  const bin = tmp();
  symlinkSync(CLI, path.join(bin, 'chaff'));
  const r = spawnSync(process.execPath, [path.join(bin, 'chaff'), 'statusline', '--install'], { encoding: 'utf8', env: e.vars, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(e.settings).statusLine.command, GLOBAL_COMMAND);
});
