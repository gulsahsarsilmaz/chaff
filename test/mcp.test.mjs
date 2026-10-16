/**
 * The MCP surface is how Codex, Cursor and Zed reach chaff, and it is the one surface where a
 * model — not a person — is choosing the arguments. These tests care about two things: that
 * the protocol handshake is well-formed, and that no amount of confident tool-calling gets
 * past the tier gates.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chaff.mjs');

/** Drive the server with a batch of JSON-RPC lines and return the parsed replies by id. */
// Its own state dir and no machine-wide stores: the server must never read or write the
// developer's real ~/.chaff, nor size their real package stores.
const STATE = mkdtempSync(path.join(os.tmpdir(), 'chaff-mcp-state-'));
after(() => rmSync(STATE, { recursive: true, force: true }));
// Explicit roots, too: inferred ones would be this checkout and its parent directory, i.e.
// whatever else the developer keeps next to it.
mkdirSync(path.join(STATE, 'code'));
writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({ roots: [path.join(STATE, 'code')] }));
const ENV = { ...process.env, CHAFF_HOME: STATE, CHAFF_STORES: 'none' };

const rpc = (...msgs) => {
  const r = spawnSync(process.execPath, [CLI, 'mcp'], {
    input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 120_000,
    env: ENV,
  });
  assert.equal(r.error, undefined, `server failed to run: ${r.error?.message}`);
  const out = (r.stdout || '').trim();
  return out ? out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } };

test('initialize returns a well-formed handshake', () => {
  const [res] = rpc(init);
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.serverInfo.name, 'chaff');
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.ok(res.result.capabilities.tools, 'must advertise tool capability');
});

test('an unknown protocol version falls back rather than failing the handshake', () => {
  const [res] = rpc({ ...init, params: { protocolVersion: '1999-01-01', capabilities: {} } });
  assert.ok(res.result, 'handshake must still succeed');
  assert.equal(res.result.protocolVersion, '2025-06-18', 'should offer our latest instead');
});

test('every advertised tool has a name, description and input schema', () => {
  const [, list] = rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = list.result.tools;
  assert.ok(tools.length >= 6, `expected the full tool set, got ${tools.length}`);
  for (const t of tools) {
    assert.match(t.name, /^chaff_[a-z_]+$/, `bad tool name: ${t.name}`);
    assert.ok(t.description.length > 40, `${t.name} needs a description a model can act on`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object`);
  }
});

test('the read-only tools are annotated read-only, and the cleaning ones are not', () => {
  const [, list] = rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const by = Object.fromEntries(list.result.tools.map((t) => [t.name, t.annotations]));
  for (const n of ['chaff_status', 'chaff_plan', 'chaff_doctor', 'chaff_worktrees']) {
    assert.equal(by[n].readOnlyHint, true, `${n} must be advertised read-only`);
  }
  assert.equal(by.chaff_clean.readOnlyHint, false);
  assert.equal(by.chaff_clean.destructiveHint, true, 'chaff_clean must warn clients it destroys');
  // reap kills processes and deletes files; a non-destructive hint lets clients auto-approve it.
  assert.equal(by.chaff_reap.destructiveHint, true, 'chaff_reap must warn clients it destroys');
});

test('tier 3 is unreachable over MCP no matter how it is asked for', () => {
  const call = (args) => rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_clean', arguments: args } })[1];
  for (const tier of [3, 4, '3', 99]) {
    const res = call({ tier, confirm: true });
    assert.equal(res.result.isError, true, `tier ${tier} must be refused`);
    assert.match(res.result.content[0].text, /tier must be 1 or 2/);
  }
});

test('cleaning without confirm:true is refused', () => {
  for (const confirm of [false, undefined, 'true', 1]) {
    const [, res] = rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_clean', arguments: { tier: 2, confirm } } });
    assert.equal(res.result.isError, true, `confirm=${JSON.stringify(confirm)} must be refused`);
    assert.match(res.result.content[0].text, /confirm:true/);
  }
});

test('a refused tool call is an isError result, not a protocol error', () => {
  // The model has to be able to read why it was refused and correct itself.
  const [, res] = rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_clean', arguments: { tier: 3, confirm: true } } });
  assert.equal(res.error, undefined, 'must not be a JSON-RPC error');
  assert.ok(res.result.content[0].text.length > 0);
});

test('an unknown tool is a protocol error', () => {
  const [, res] = rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_delete_everything' } });
  assert.equal(res.error.code, -32602);
});

test('notifications get no reply, requests for unknown methods do', () => {
  const out = rpc(init, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 9, method: 'no/such/method' });
  assert.equal(out.length, 2, 'exactly one reply for init and one for the bad request');
  assert.equal(out[1].error.code, -32601);
});

test('malformed input is answered with a parse error, and the server keeps serving', () => {
  const r = spawnSync(process.execPath, [CLI, 'mcp'], {
    input: 'not json at all\n' + JSON.stringify(init) + '\n',
    encoding: 'utf8', timeout: 120_000, env: ENV,
  });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].result.serverInfo.name, 'chaff', 'must recover and serve the next message');
});

test('a read-only tool call reaches the CLI and comes back without error', () => {
  const [, res] = rpc(init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chaff_reap', arguments: { dry_run: true } } });
  assert.equal(res.result.isError, false, `bridge failed: ${res.result?.content?.[0]?.text}`);
  assert.ok(res.result.content[0].type === 'text');
});

const slHomes = [];
after(() => { for (const d of slHomes) rmSync(d, { recursive: true, force: true }); });

test('statusline never exits non-zero, whatever the cache contains', () => {
  // It lives in shell prompts and tmux status bars. A broken cache must degrade to a
  // placeholder, never to a failed command that noisily breaks someone's prompt.
  
  for (const body of ['', 'not json', '{}', '{"schema":2}', '{"schema":2,"totals":{}}']) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'chaff-sl-'));
    writeFileSync(path.join(home, 'scan-cache.json'), body);
    // An unusable cache makes statusline start a detached `scan --fresh` that outlives this
    // test. With inferred roots and real stores, five of those sized the developer's whole
    // code folder and package caches at once and starved the rest of the suite into a hang.
    mkdirSync(path.join(home, 'code'));
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [path.join(home, 'code')] }));
    slHomes.push(home);                       // removed in after(): the refresh may still be writing
    const r = spawnSync(process.execPath, [CLI, 'statusline', '--plain'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, CHAFF_HOME: home, CHAFF_STORES: 'none' },
    });
    assert.equal(r.status, 0, `cache ${JSON.stringify(body)} produced exit ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.startsWith('chaff'), `expected a chaff line, got ${JSON.stringify(r.stdout)}`);
  }
});
