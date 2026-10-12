/**
 * The update notice. It must never slow a prompt or a session (the network call is detached
 * and at most daily), never claim a prerelease or garbage is newer, and never nag: the
 * session notice fires once per version while the statusline keeps the reminder.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'scripts', 'hook-session-start.mjs');
const CLI = path.join(ROOT, 'scripts', 'chaff.mjs');
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CURRENT = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let home, server, registry, served = '99.0.0', uc;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'chaff-update-'));
  process.env.CHAFF_HOME = home;
  delete process.env.CI; delete process.env.NO_UPDATE_NOTIFIER; delete process.env.CHAFF_NO_UPDATE_CHECK;
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: '@gulsahsarsilmaz/chaff', version: served }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  registry = `http://127.0.0.1:${server.address().port}`;
  process.env.CHAFF_REGISTRY = registry;
  uc = await import('../scripts/update-check.mjs?update-test');
});
// The session hook starts a detached scan that may still be writing into `home` when the
// tests finish; retry the removal rather than race it.
after(() => { server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const state = () => JSON.parse(readFileSync(path.join(home, 'update-check.json'), 'utf8'));
const setState = (s) => writeFileSync(path.join(home, 'update-check.json'), JSON.stringify(s));
const env = { ...process.env, CI: '', CHAFF_HOME: undefined };

for (const [latest, current, want] of [
  ['0.3.4', '0.3.3', true], ['0.4.0', '0.3.9', true], ['0.10.0', '0.9.9', true], ['1.0.0', '0.99.99', true],
  ['0.3.3', '0.3.3', false], ['0.3.2', '0.3.3', false],
  ['0.4.0-beta.1', '0.3.3', false], ['0.0.0-stage', '0.3.3', false], ['garbage', '0.3.3', false], [undefined, '0.3.3', false],
]) {
  test(`isNewer(${latest}, ${current}) is ${want}`, () => assert.equal(uc.isNewer(latest, current), want));
}

test('refreshNow caches the registry\'s latest version, and availableUpdate reads it', async () => {
  assert.equal(await uc.refreshNow(), '99.0.0');
  assert.equal(state().latest, '99.0.0');
  assert.deepEqual(uc.availableUpdate({ current: '0.3.3' }), { current: '0.3.3', latest: '99.0.0' });
});

test('an unreachable registry means no notice, not an error', async () => {
  const saved = process.env.CHAFF_REGISTRY;
  process.env.CHAFF_REGISTRY = 'http://127.0.0.1:1';
  const mod = await import('../scripts/update-check.mjs?unreachable');
  process.env.CHAFF_REGISTRY = saved;
  assert.equal(await mod.refreshNow(), null);
});

test('it can be turned off by config, env and CI', () => {
  setState({ checkedAt: Date.now(), latest: '99.0.0' });
  assert.equal(uc.availableUpdate({ current: '0.3.3', cfg: { updateCheck: false } }), null);
  for (const k of ['CHAFF_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'CI']) {
    process.env[k] = '1';
    assert.equal(uc.availableUpdate({ current: '0.3.3' }), null, k);
    delete process.env[k];
  }
});

test('the network is asked at most once a day', () => {
  setState({ checkedAt: Date.now() });
  assert.equal(uc.refreshInBackground(), false);
  setState({ checkedAt: Date.now() - (uc.CHECK_EVERY_SEC + 60) * 1000 });
  // The detached child inherits this env: point it nowhere so it cannot race later tests.
  process.env.CHAFF_REGISTRY = 'http://127.0.0.1:1';
  try { assert.equal(uc.refreshInBackground(), true); } finally { process.env.CHAFF_REGISTRY = registry; }
  assert.ok(Date.now() - state().checkedAt < 5000, 'the slot is claimed before fetching');
});

test('each install method gets its own update command', () => {
  assert.equal(uc.installKind('/u/.claude/plugins/cache/chaff/chaff/0.3.3/scripts', {}), 'plugin');
  assert.equal(uc.installKind('/opt/homebrew/Cellar/chaff/0.3.3/libexec/scripts', {}), 'brew');
  assert.equal(uc.installKind('/u/.npm/_npx/abc/node_modules/@gulsahsarsilmaz/chaff/scripts', {}), 'npx');
  assert.equal(uc.installKind('/usr/local/lib/node_modules/@gulsahsarsilmaz/chaff/scripts', {}), 'npm');
  assert.match(uc.UPDATE_HOW.plugin, /\/plugin marketplace update chaff/);
  assert.match(uc.UPDATE_HOW.plugin, /\/reload-plugins/);
  assert.equal(uc.UPDATE_HOW.brew, 'brew upgrade chaff');
});

const runHook = () => {
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', cwd: home, input: '{}',
    env: { ...env, CHAFF_HOME: home, CHAFF_REGISTRY: registry, CLAUDE_PLUGIN_ROOT: ROOT },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : {};
};

test('the session hook shows the user a notice once per version', () => {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoStatusline: false }));
  setState({ checkedAt: Date.now(), latest: '99.0.0' });
  const first = runHook();
  assert.match(first.systemMessage, new RegExp(`chaff 99\\.0\\.0 is available \\(you have ${escapeRe(CURRENT)}\\)`));
  assert.match(first.systemMessage, /\/reload-plugins/);
  assert.match(first.hookSpecificOutput.additionalContext, /99\.0\.0/);
  assert.equal(runHook().systemMessage, undefined, 'the same version is not announced twice');
  setState({ ...state(), latest: '99.0.1' });
  assert.match(runHook().systemMessage, /99\.0\.1/, 'a newer release is announced again');
});

test('chaff version prints the version and the update command', () => {
  setState({ checkedAt: Date.now(), latest: '99.0.0' });
  const r = spawnSync(process.execPath, [CLI, 'version'], { encoding: 'utf8', env: { ...env, CHAFF_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^chaff ${escapeRe(CURRENT)}\\n`));
  assert.match(r.stdout, /chaff 99\.0\.0 is available/);
});
