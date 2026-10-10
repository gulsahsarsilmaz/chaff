/**
 * The PreToolUse guard runs on every Bash call. Whatever it decides applies to the WHOLE
 * command, so `allow` would approve `rm -rf ~/x; npm run build` on the user's behalf.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hook-pre-build.mjs');

const runHook = ({ freeGb, command, mode = 'default' }) => {
  const home = mkdtempSync(path.join(tmpdir(), 'chaff-hook-'));
  try {
    writeFileSync(path.join(home, 'scan-cache.json'), JSON.stringify({
      scannedAt: new Date().toISOString(), disk: { freeGb },
    }));
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ permission_mode: mode, tool_input: { command } }),
      encoding: 'utf8', env: { ...process.env, CHAFF_HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  } finally { rmSync(home, { recursive: true, force: true }); }
};

const decision = (out) => out?.hookSpecificOutput?.permissionDecision;

for (const mode of ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']) {
  for (const freeGb of [5, 40]) {
    test(`never approves a command on the user's behalf (${mode}, ${freeGb}GB free)`, () => {
      const out = runHook({ freeGb, mode, command: 'rm -rf ~/x; npm run build' });
      assert.notEqual(decision(out), 'allow');
      assert.notEqual(decision(out), 'deny', 'a wrong guess must not block real work');
    });
  }
}

test('asks when disk is critical and someone is watching', () => {
  assert.equal(decision(runHook({ freeGb: 5, command: 'npm run build' })), 'ask');
});

test('only warns when below the floor but not critical', () => {
  const out = runHook({ freeGb: 40, command: 'npm run build' });
  assert.equal(decision(out), undefined);
  assert.match(out.systemMessage, /below your 60GB floor/);
});

test('says nothing for a non-build command or a healthy disk', () => {
  assert.equal(runHook({ freeGb: 5, command: 'ls -la' }), null);
  assert.equal(runHook({ freeGb: 500, command: 'npm run build' }), null);
});
