/**
 * chaff_clean's `confirm: true` is set by the model, so it is not consent. These tests drive
 * the server the way a client would and check the two real gates: the person answering an
 * elicitation, or a planId from a plan the person was shown — bound to exactly that plan.
 *
 * Every scan here comes from a seeded cache in a temp CHAFF_HOME, so the one thing that can
 * be cleaned is a temp directory the test made. Nothing on the machine running it is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');

/** A temp CHAFF_HOME whose cached scan plans exactly one tier-1 removal per leftover dir. */
function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'chaff-consent-')));
  const home = path.join(base, 'home');
  mkdirSync(path.join(base, 'roots'), { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ scanTtlSeconds: 86400, roots: [path.join(base, 'roots')], progress: false }));
  const leftovers = [];
  const seed = (n) => {
    while (leftovers.length < n) {
      const dir = path.join(base, `leftover-${leftovers.length}`);
      mkdirSync(dir); writeFileSync(path.join(dir, 'a.js'), 'x');
      leftovers.push(dir);
    }
    writeFileSync(path.join(home, 'scan-cache.json'), JSON.stringify({
      schema: 2, scannedAt: new Date().toISOString(), roots: [path.join(base, 'roots')], rootsInferred: false, rootsRefused: null,
      disk: { totalGb: 1000, usedGb: 10, freeGb: 990, pctUsed: 1 },
      totals: { nodeProcs: 0, nodeRssMb: 0, claudeProcs: 0, daemons: 0, projects: 1, worktrees: 0, cacheMb: 0, outputMb: n, storeMb: 0 },
      projects: [{ root: path.join(base, 'roots', 'gone'), name: 'gone', exists: false, kind: 'js',
        artifacts: leftovers.map((p) => ({ path: p, tool: 'vite', category: 'output', sizeMb: 1, tracked: false })) }],
      stores: [], worktrees: [], orphanArtifacts: [], processes: [],
    }));
  };
  seed(1);
  return { home, leftovers, seed, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A live server. `call` sends a request and resolves with its response; `onRequest` answers the server's. */
function session(home, { elicitation = false, answer } = {}) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, CHAFF_HOME: home, CI: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  const asked = [];
  let buf = '', n = 0;
  const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.method === 'elicitation/create') {
        asked.push(msg.params);
        const res = answer(msg.params);
        write(res.error ? { jsonrpc: '2.0', id: msg.id, error: res.error } : { jsonrpc: '2.0', id: msg.id, result: res });
      } else waiting.get(msg.id)?.(msg);
    }
  });
  const call = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); write({ jsonrpc: '2.0', id, method, params }); });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result;
  const ready = call('initialize', { protocolVersion: '2025-06-18', capabilities: elicitation ? { elicitation: {} } : {} });
  return { ready, tool, asked, close: () => child.stdin.end() };
}

const text = (r) => r.content[0].text;
const planIdOf = (r) => text(r).match(/planId: ([0-9a-f]+)/)?.[1];

test('with elicitation, an accepted prompt applies the cleanup', async () => {
  const f = fixture();
  const s = session(f.home, { elicitation: true, answer: () => ({ action: 'accept', content: { apply: true } }) });
  try {
    await s.ready;
    const r = await s.tool('chaff_clean', { tier: 1, confirm: true });
    assert.equal(s.asked.length, 1, 'the person must be asked');
    assert.match(s.asked[0].message, /leftover-0/, 'the prompt must name what will be removed');
    assert.equal(r.isError, false, text(r));
    assert.equal(existsSync(f.leftovers[0]), false, 'accepted: the leftover is gone (to trash)');
  } finally { s.close(); f.cleanup(); }
});

for (const [label, answer] of [
  ['declined', { action: 'decline' }],
  ['cancelled', { action: 'cancel' }],
  ['accepted without ticking apply', { action: 'accept', content: { apply: false } }],
  ['answered with an error', { error: { code: -32603, message: 'nope' } }],
]) {
  test(`with elicitation, a prompt ${label} cleans nothing`, async () => {
    const f = fixture();
    const s = session(f.home, { elicitation: true, answer: () => answer });
    try {
      await s.ready;
      const r = await s.tool('chaff_clean', { tier: 1, confirm: true });
      assert.equal(s.asked.length, 1);
      assert.match(text(r), /Nothing was cleaned/);
      assert.equal(existsSync(f.leftovers[0]), true, 'nothing may be removed');
    } finally { s.close(); f.cleanup(); }
  });
}

test('without elicitation and without a planId, chaff_clean is only a dry run', async () => {
  const f = fixture();
  const s = session(f.home);
  try {
    await s.ready;
    const r = await s.tool('chaff_clean', { tier: 1, confirm: true });
    assert.match(text(r), /DRY RUN/);
    assert.match(text(r), /dry-run/, 'shows what would be applied');
    assert.equal(existsSync(f.leftovers[0]), true, 'a dry run removes nothing');
  } finally { s.close(); f.cleanup(); }
});

test('without elicitation, a planId from chaff_plan lets the cleanup proceed, once', async () => {
  const f = fixture();
  const s = session(f.home);
  try {
    await s.ready;
    const id = planIdOf(await s.tool('chaff_plan', {}));
    assert.ok(id, 'chaff_plan must return a planId');
    const r = await s.tool('chaff_clean', { tier: 1, confirm: true, planId: id });
    assert.equal(r.isError, false, text(r));
    assert.equal(existsSync(f.leftovers[0]), false, 'the agreed plan was applied');
    const again = await s.tool('chaff_clean', { tier: 1, confirm: true, planId: id });
    assert.equal(again.isError, true, 'a planId is single use');
  } finally { s.close(); f.cleanup(); }
});

test('an unknown planId is refused', async () => {
  const f = fixture();
  const s = session(f.home);
  try {
    await s.ready;
    const r = await s.tool('chaff_clean', { tier: 1, confirm: true, planId: 'deadbeefdeadbeef' });
    assert.equal(r.isError, true);
    assert.match(text(r), /unknown or older/);
    assert.equal(existsSync(f.leftovers[0]), true);
  } finally { s.close(); f.cleanup(); }
});

test('a planId is refused when the plan changed after the user saw it', async () => {
  const f = fixture();
  const s = session(f.home);
  try {
    await s.ready;
    const id = planIdOf(await s.tool('chaff_plan', {}));
    f.seed(2);                                  // a second removal appears after planning
    const r = await s.tool('chaff_clean', { tier: 1, confirm: true, planId: id });
    assert.equal(r.isError, true);
    assert.match(text(r), /plan has changed/);
    assert.ok(f.leftovers.every(existsSync), 'nothing may be removed under stale consent');
  } finally { s.close(); f.cleanup(); }
});

test('the CLI refuses an apply whose plan does not match --expect', async () => {
  const f = fixture();
  try {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, 'apply', '--tier=1', '--yes', '--expect=0000000000000000'], { env: { ...process.env, CHAFF_HOME: f.home, CI: '' } });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => resolve({ code, err }));
    });
    assert.equal(r.code, 2);
    assert.match(r.err, /plan changed/);
    assert.equal(existsSync(f.leftovers[0]), true);
  } finally { f.cleanup(); }
});
