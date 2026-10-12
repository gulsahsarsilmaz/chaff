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
 *
 * Consent for tiers 1-2: `confirm: true` is an argument the model sets itself, so on its own
 * it proves nothing. chaff_clean therefore asks the person directly through MCP elicitation
 * when the client supports it. When it does not, the call must carry a planId from a recent
 * chaff_plan, which the model has to have shown; without one, chaff_clean only dry-runs.
 * Either way the CLI is run with `--expect`, so what is applied is exactly what was agreed to.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDigest } from './plan-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'chaff.mjs');
// Read, not hardcoded: the release workflow checks package.json against the tag, and a
// literal here drifted past that check.
const SERVER_VERSION = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

/** Versions we know how to speak. We echo the client's if we recognise it, else offer ours. */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED[0];

/** A scan can walk a large filesystem; a plan builds on it. Generous, but never unbounded. */
const TIMEOUT_MS = 120_000;

/** How long a planId from chaff_plan stays spendable, and how long we wait on a person. */
const PLAN_TTL_MS = 10 * 60_000;
const ELICIT_TIMEOUT_MS = 10 * 60_000;

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
      + 'Always show this to the user before cleaning anything. The output ends with a planId; '
      + 'chaff_clean needs it when the client cannot ask the user for confirmation itself.',
    annotations: { title: 'Cleanup plan (read-only)', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        fresh: { type: 'boolean', description: 'Re-scan before planning.' },
        json: { type: 'boolean', description: 'Return the raw plan array instead of the rendered table.' },
      },
    },
    argv: (a) => ['plan', ...(a.fresh ? ['--fresh'] : []), ...(a.json ? ['--json'] : [])],
    call: plan,
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
      'Reclaim ONLY tier 1 — toolchain processes, worktree records and build output whose project '
      + 'directory no longer exists on disk. This stops processes and deletes files; run chaff_plan '
      + 'first and tell the user what it will do. For anything beyond tier 1 use chaff_clean, which '
      + 'requires explicit confirmation.',
    annotations: { title: 'Reclaim dead resources (tier 1)', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { dry_run: { type: 'boolean', description: 'Report what would be reaped without doing it.' } },
    },
    argv: (a) => ['reap', ...(a.dry_run ? ['--dry-run'] : [])],
  },
  {
    name: 'chaff_clean',
    description:
      'Apply cleanup up to tier 2: deletes stale build output and caches, stops idle daemons and '
      + 'long-running dev servers, removes merged clean worktrees (including their ignored files, '
      + 'such as .env) and prunes package stores. Deleted build output and caches go to chaff trash, '
      + 'recoverable with `chaff restore`; stopped processes, removed worktrees and pruned stores are '
      + 'not. Requires confirm:true, and you must show the user chaff_plan output and get their '
      + 'agreement first. If the client supports elicitation, chaff asks the user directly before '
      + 'anything runs. Otherwise pass the planId that chaff_plan returned (valid 10 minutes, '
      + 'single use); without it this is a dry run, and if the plan has changed since, it is refused. '
      + 'Tier 3 is deliberately not available here — it touches running processes and uncommitted '
      + 'code, and must be run by a person at a terminal.',
    annotations: { title: 'Apply cleanup (tier 1-2)', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'integer', enum: [1, 2], description: 'Highest tier to apply. 1 = provably dead only, 2 = also regenerable output. Tier 3 is not permitted over MCP.' },
        confirm: { type: 'boolean', description: 'Must be true. Set it only after the user has seen the plan and agreed.' },
        planId: { type: 'string', description: 'The planId from the chaff_plan output the user saw. Required to apply when the client cannot ask the user itself.' },
        dry_run: { type: 'boolean', description: 'Show what would be applied without applying it.' },
      },
      required: ['tier', 'confirm'],
    },
    call: clean,
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

// ---- consent ---------------------------------------------------------------------------

/** Set at initialize: whether the client can put a question to the person (MCP elicitation). */
let canElicit = false;

/** planId -> { at, digests: { 1, 2 } }. Spent on use; dropped once older than PLAN_TTL_MS. */
const plans = new Map();
const sweepPlans = () => { for (const [k, v] of plans) if (Date.now() - v.at > PLAN_TTL_MS) plans.delete(k); };

/** The plan as data, for fingerprinting and for describing it to a person. Null on failure. */
function planActions(fresh) {
  const { ok, text } = run(['plan', '--json', ...(fresh ? ['--fresh'] : [])]);
  if (!ok) return null;
  try { const p = JSON.parse(text); return Array.isArray(p?.actions) ? p.actions : null; } catch { return null; }
}

async function plan(a) {
  const shown = run(TOOLS.find((t) => t.name === 'chaff_plan').argv(a));
  if (!shown.ok) return toolText(shown.text || '(no output)', true);
  // The rendered plan above just scanned (or read a fresh cache), so this reads the same scan.
  const actions = planActions(false);
  if (!actions) return toolText(shown.text || '(no output)');
  sweepPlans();
  const planId = randomBytes(8).toString('hex');
  plans.set(planId, { at: Date.now(), digests: { 1: planDigest(actions, 1), 2: planDigest(actions, 2) } });
  return toolText(`${shown.text || '(no output)'}\n\nplanId: ${planId}  (for chaff_clean; valid ${PLAN_TTL_MS / 60_000} minutes, once)`);
}

const describe = (actions, tier) => {
  const live = actions.filter((x) => x.tier <= tier && !x.blocked);
  const gbOf = (mb) => (mb / 1024).toFixed(1);
  const lines = live.slice(0, 15).map((x) => `  tier ${x.tier}  ${x.kind}  ${x.target}`);
  if (live.length > 15) lines.push(`  …and ${live.length - 15} more`);
  return { count: live.length, text: `chaff wants to apply tier ${tier === 1 ? '1' : '1-2'} cleanup: `
    + `${live.length} action${live.length === 1 ? '' : 's'}, about ${gbOf(live.reduce((n, x) => n + (x.reclaimMb || 0), 0))}GB.\n`
    + `${lines.join('\n')}\nDeleted files go to chaff trash; stopped processes and pruned stores cannot be restored.` };
};

async function clean(a) {
  const tier = Number(a.tier);
  if (!Number.isInteger(tier) || tier < 1 || tier > 2) return toolText('tier must be 1 or 2. Tier 3 touches running work and uncommitted code, and is not reachable over MCP — run `chaff clean --tier=3 --yes --force` in a terminal.', true);
  if (a.confirm !== true) return toolText('refusing to clean without confirm:true. Show the user `chaff_plan` output and get their agreement first.', true);
  const dryRun = (note) => {
    const r = run(['apply', `--tier=${tier}`, '--yes', '--dry-run']);
    return toolText(note ? `${note}\n\n${r.text || '(no output)'}` : r.text || '(no output)', !r.ok);
  };
  if (a.dry_run) return dryRun();

  const actions = planActions(false);
  if (!actions) return toolText('chaff: could not build a plan to confirm against; nothing was applied.', true);
  const digest = planDigest(actions, tier);
  const apply = () => { const r = run(['apply', `--tier=${tier}`, '--yes', `--expect=${digest}`]); return toolText(r.text || '(no output)', !r.ok); };

  if (canElicit) {
    const { count, text } = describe(actions, tier);
    if (!count) return toolText('Nothing to clean at this tier.');
    const answer = await elicit(text);
    if (answer?.action === 'accept' && answer.content?.apply === true) return apply();
    const why = answer?.action === 'decline' ? 'the user declined' : answer?.action === 'accept' ? 'the user did not tick "apply"' : 'the user did not answer';
    return toolText(`Nothing was cleaned: ${why}.`);
  }

  if (!a.planId) {
    return dryRun('DRY RUN — nothing was changed. This client cannot ask the user directly, so applying needs '
      + 'the planId from a chaff_plan output the user has seen and agreed to.');
  }
  sweepPlans();
  const seen = plans.get(a.planId);
  if (!seen) return toolText('refusing: that planId is unknown or older than 10 minutes. Run chaff_plan again and show the user.', true);
  plans.delete(a.planId);                     // single use, even if what follows refuses
  if (seen.digests[tier] !== digest) {
    return toolText('refusing: the plan has changed since the user saw it, so their agreement does not cover it. '
      + 'Run chaff_plan again and show the user.', true);
  }
  return apply();
}

// ---- JSON-RPC plumbing -----------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** A tool that failed is reported through isError, not a protocol error: the model should see why. */
function toolText(text, isError = false) { return { content: [{ type: 'text', text }], isError }; }

/** Requests we sent the client, awaiting its response: id -> resolve. */
const pending = new Map();
let nextOutgoing = 0;

/**
 * Ask the person, through the client. Resolves to the client's result ({ action, content }),
 * or null on an error response or no answer in time — both of which mean "not agreed".
 */
function elicit(message) {
  const id = `chaff-elicit-${++nextOutgoing}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ELICIT_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg.error ? null : msg.result); });
    send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
      message,
      requestedSchema: {
        type: 'object',
        properties: { apply: { type: 'boolean', title: 'Apply this cleanup', default: false } },
        required: ['apply'],
      },
    } });
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  // A response to something we asked the client (elicitation), not a request to us.
  if (method === undefined && isRequest) {
    const done = pending.get(id);
    if (done) { pending.delete(id); done(msg); }
    return;
  }

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      canElicit = Boolean(params?.capabilities?.elicitation);
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
      if (tool.call) return reply(id, await tool.call(params?.arguments || {}));
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
    // Not awaited: a tool call waiting on the person must not stop us reading their answer.
    const p = handle(msg).catch((e) => {
      if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) fail(msg.id, -32603, e.message);
    });
    inflight.add(p); p.finally(() => inflight.delete(p));
  }
});
// Finish what is in flight before exiting, so a reply is never cut off by stdin closing.
const inflight = new Set();
process.stdin.on('end', () => {
  for (const done of pending.values()) done({ error: { message: 'client went away' } });
  Promise.allSettled([...inflight]).then(() => process.exit(0));
});
