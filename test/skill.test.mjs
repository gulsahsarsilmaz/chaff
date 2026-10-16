/**
 * The agent skill tells a model when and how to use chaff. It ships to people who never read
 * the README, so it must not drift from what the MCP server actually offers, and it must never
 * steer an agent toward tier 3 on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// A Windows checkout may have CRLF line endings.
const SKILL = readFileSync(path.resolve('skills/chaff/SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const MCP = readFileSync(path.resolve('scripts/mcp.mjs'), 'utf8');
const PKG = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));

test('skill: frontmatter has the name and a description agents can match on', () => {
  const fm = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'frontmatter block');
  assert.match(fm[1], /^name: chaff$/m);
  const desc = fm[1].match(/^description: (.+)$/m)?.[1] ?? '';
  assert.ok(desc.length > 80 && desc.length <= 1024, `description length ${desc.length}`);
  assert.match(desc, /ENOSPC/);
});

test('skill: every MCP tool it names exists, and every MCP tool is named', () => {
  const served = new Set([...MCP.matchAll(/name: '(chaff_\w+)'/g)].map((m) => m[1]));
  const named = new Set([...SKILL.matchAll(/\b(chaff_\w+)\b/g)].map((m) => m[1]));
  assert.deepEqual([...named].sort(), [...served].sort());
});

test('skill: tier 3 is left to the person, never applied by the agent', () => {
  assert.match(SKILL, /Never apply tier 3 yourself/);
  for (const line of SKILL.split('\n').filter((l) => /--tier=3/.test(l))) {
    assert.match(line, /--force/, 'tier 3 is only ever shown as the full human command');
  }
  assert.doesNotMatch(SKILL, /tier: 3/);
});

test('skill: ships in the npm package alongside the plugin', () => {
  assert.ok(PKG.files.includes('skills'));
});
