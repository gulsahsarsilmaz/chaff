/**
 * What chaff prints, pinned. Every screen is rendered from one fixed scan
 * (test/fixtures/scan.json) and compared with test/fixtures/render/*.txt, so a refactor that
 * moves rendering code cannot change a single character without a test saying so.
 *
 * Changed the output on purpose? Regenerate, then read the diff before committing:
 *   UPDATE_SNAPSHOTS=1 node --test test/render.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(HERE, 'fixtures', 'render');
const skip = process.platform === 'win32' && 'fixture paths are POSIX';
let chaff, s, cfg;

before(async () => {
  // chaff reads HOME and CHAFF_HOME when it loads, and doctor looks at the trash, schedule and
  // statusline settings there: point all of it at an empty dir, or the snapshot is this
  // machine's state rather than the fixture's.
  const home = mkdtempSync(path.join(tmpdir(), 'chaff-render-'));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CHAFF_HOME: path.join(home, '.chaff'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CACHE_HOME: path.join(home, '.cache'), CI: '' });
  process.env.COLUMNS = '100';          // stdout is not a TTY under node --test
  delete process.env.NO_COLOR;
  chaff = await import('../scripts/chaff.mjs');
  s = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'scan.json'), 'utf8'));
  cfg = { ...chaff.DEFAULTS, ...s.config, thresholds: s.config.thresholds, protect: [], statuslineStyle: 'plain' };
});

const check = (name, text) => {
  const file = path.join(SNAP, `${name}.txt`);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
    mkdirSync(SNAP, { recursive: true });
    writeFileSync(file, text);
    if (!process.env.UPDATE_SNAPSHOTS) assert.fail(`no snapshot for ${name}; wrote one — review it and rerun`);
    return;
  }
  assert.equal(text, readFileSync(file, 'utf8'), `${name} changed; if intended, UPDATE_SNAPSHOTS=1 and review the diff`);
};

const screens = {
  'status-wide': () => chaff.renderScan(s, cfg, { width: 120 }),
  'status-narrow': () => chaff.renderScan(s, cfg, { width: 80 }),
  'status-explain': () => chaff.renderScan(s, cfg, { width: 120, explain: true }),
  'plan': () => chaff.renderPlan(chaff.buildPlan(s, cfg)),
  'plan-json': () => JSON.stringify(chaff.buildPlan(s, cfg), null, 1),
  'top': () => chaff.renderTop(s, 10),
  'doctor': () => chaff.renderDoctor(s, chaff.buildPlan(s, cfg), cfg),
  'worktrees': () => chaff.renderWorktrees(s, cfg),
  'worktrees-dirty': () => chaff.renderWorktrees(s, cfg, { dirtyOnly: true }),
  'statusline-plain': () => chaff.renderStatusline(s, cfg),
  'statusline-dots': () => chaff.renderStatusline(s, { ...cfg, statuslineStyle: 'dots' }),
  'statusline-color': () => chaff.renderStatusline(s, { ...cfg, statuslineStyle: 'color' }),
};

for (const [name, render] of Object.entries(screens)) {
  test(`${name} renders exactly as before`, { skip }, () => check(name, String(render())));
}

test('rendering is deterministic', { skip }, () => {
  for (const render of Object.values(screens)) assert.equal(String(render()), String(render()));
});
