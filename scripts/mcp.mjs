#!/usr/bin/env node
/**
 * chaff as an MCP server, over stdio.
 *
 * This is what makes chaff agent-agnostic: Codex, Cursor, Zed, Windsurf and Claude Code all
 * speak MCP, so one server covers all of them. The Claude Code plugin stays the richer
 * surface (statusline, hooks) — this is the portable floor, not a replacement.
 *
 * It shells out to chaff.mjs rather than importing it. The CLI's `--json` contract is the
 * stable interface; importing would freeze a dozen internal render functions as public API
 * on a pre-1.0 project. A tool call is user-initiated and infrequent, so the spawn costs
 * nothing that matters.
 *
 * Hand-rolled JSON-RPC, because chaff has no runtime dependencies and is not about to grow
 * one to print newline-delimited JSON.
 *
 * Safety: tier 3 is NOT reachable over MCP at all. It touches running processes and
 * uncommitted code, and an agent deciding that on its own — possibly auto-approved — is not
 * a risk worth the convenience. Tier 3 stays a human at a terminal.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'chaff.mjs');
const SERVER_VERSION = '0.2.0';

/** Versions we know how to speak. We echo the client's if we recognise it, else offer ours. */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED[0];

/** A scan can walk a large filesystem; a plan builds on it. Generous, but never unbounded. */
const TIMEOUT_MS = 120_000;

const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, text: `chaff: timed out after ${TIMEOUT_MS / 1000}s. Try \`chaff scan --fresh\` from a terminal.` };
  if (r.error) return { ok: false, text: `chaff: could not run (${r.error.message})` };
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  // chaff uses exit 2 for refusals and 3 for "no scan available" — both are real answers,
  // not crashes, and the message is the useful part.
  if (r.status !== 0 && !out) return { ok: false, text: err || `chaff exited ${r.status}` };
  return { ok: true, text: out || err };
};

const TOOLS = [
  {
    name: 'chaff_status',
    description:
      'Current pressure on this developer machine: toolchain memory by process, build daemons, '
      + 'disk free, build cache and output size, package stores, and git worktree count. Read-only. '
      + 'Use when the user reports the machine being slow, stuck, or out of disk.',
    annotations: { title: 'Machine pressure', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        fresh: { type: 'boolean', description: 'Bypass the scan cache and re-scan now. Slower; use when the user just deleted or built something.' },
        json: { type: 'boolean', description: 'Return the raw scan object instead of the rendered readout.' },
      },
    },
    argv: (a) => ['status', ...(a.fresh ? ['--fresh'] : []), ...(a.json ? ['--json'] : []), '--width=100'],
  },
  {
    name: 'chaff_plan',
    description:
      'What chaff would clean, grouped by safety tier, and how much each would reclaim. '
      + 'Changes nothing. Tier 1 is provably dead, tier 2 is regenerable, tier 3 touches live work. '
      + 'Always show this to the user before cleaning anything.',
    annotations: { title: 'Cleanup plan (read-only)', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        fresh: { type: 'boolean', description: 'Re-scan before planning.' },
        json: { type: 'boolean', description: 'Return the raw plan array instead of the rendered table.' },
      },
    },
    argv: (a) => ['plan', ...(a.fresh ? ['--fresh'] : []), ...(a.json ? ['--json'] : [])],
  },
  {
    name: 'chaff_doctor',
    description:
      'Diagnosis rather than inventory: what is actually misconfigured on this machine — '
      + 'unshared Cargo target dirs, non-hardlinked installs, outdated nx cache layout, daemon '
      + 'and worktree sprawl — and the specific command that fixes each one. Read-only.',
    annotations: { title: 'Diagnose configuration', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { fresh: { type: 'boolean', description: 'Re-scan before diagnosing.' } } },
    argv: (a) => ['doctor', ...(a.fresh ? ['--fresh'] : [])],
  },
  {
    name: 'chaff_worktrees',
    description:
      'Every git worktree found, how stale it is, and exactly what is uncommitted in each. '
      + 'Read-only. Use before suggesting any worktree cleanup, so uncommitted work is visible first.',
    annotations: { title: 'Git worktrees', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        dirty: { type: 'boolean', description: 'Only worktrees with uncommitted changes.' },
        json: { type: 'boolean', description: 'Return the raw worktree array.' },
      },
    },
    argv: (a) => ['worktrees', ...(a.dirty ? ['--dirty'] : []), ...(a.json ? ['--json'] : [])],
  },
  {
    name: 'chaff_reap',
    description:
      'Reclaim ONLY tier 1 — resources whose project directory no longer exists on disk. '
      + 'Provably dead, nothing to recover. Safe to run without asking. For anything beyond '
      + 'tier 1 use chaff_clean, which requires explicit confirmation.',
    annotations: { title: 'Reclaim dead resources (tier 1)', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { dry_run: { type: 'boolean', description: 'Report what would be reaped without doing it.' } },
    },
    argv: (a) => ['reap', ...(a.dry_run ? ['--dry-run'] : [])],
  },
  {
    name: 'chaff_clean',
    description:
      'Apply cleanup up to tier 2 (regenerable build output, caches and stores). Everything is '
      + 'moved to chaff trash, recoverable with `chaff restore`, not destroyed. Requires confirm:true, '
      + 'and you must show the user chaff_plan output and get their agreement first. '
      + 'Tier 3 is deliberately not available here — it touches running processes and uncommitted '
      + 'code, and must be run by a person at a terminal.',
    annotations: { title: 'Apply cleanup (tier 1-2)', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'integer', enum: [1, 2], description: 'Highest tier to apply. 1 = provably dead only, 2 = also regenerable output. Tier 3 is not permitted over MCP.' },
        confirm: { type: 'boolean', description: 'Must be true. Set it only after the user has seen the plan and agreed.' },
        dry_run: { type: 'boolean', description: 'Show what would be applied without applying it.' },
      },
      required: ['tier', 'confirm'],
    },
    argv: (a) => {
      const tier = Number(a.tier);
      if (!Number.isInteger(tier) || tier < 1 || tier > 2) throw new Error('tier must be 1 or 2. Tier 3 touches running work and uncommitted code, and is not reachable over MCP — run `chaff clean 3 --force` in a terminal.');
      if (a.confirm !== true) throw new Error('refusing to clean without confirm:true. Show the user `chaff_plan` output and get their agreement first.');
      return ['apply', `--tier=${tier}`, '--yes', ...(a.dry_run ? ['--dry-run'] : [])];
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC plumbing -----------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** A tool that failed is reported through isError, not a protocol error: the model should see why. */
const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chaff', version: SERVER_VERSION },
        instructions:
          'chaff reports and reclaims dead weight on a developer machine. Always run chaff_plan '
          + 'and show the user the result before calling chaff_clean. chaff_status, chaff_plan, '
          + 'chaff_doctor and chaff_worktrees are read-only and safe to call freely.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;                                     // notifications take no reply
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case 'tools/call': {
      const tool = byName.get(params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      let argv;
      try { argv = tool.argv(params?.arguments || {}); }
      catch (e) { return reply(id, toolText(e.message, true)); }
      const { ok, text } = run(argv);
      return reply(id, toolText(text || '(no output)', !ok));
    }
    default:
      // Only requests deserve an error; an unknown notification is silently ignored.
      if (isRequest) return fail(id, -32601, `method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    try { handle(msg); }
    catch (e) {
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, e.message);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
