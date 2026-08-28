/** Parsing that everything else depends on being right. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, etimeToSeconds, projectFromCmd } from '../scripts/chaff.mjs';

test('ps elapsed-time formats parse correctly', () => {
  assert.equal(etimeToSeconds('00:30'), 30);
  assert.equal(etimeToSeconds('05:18'), 318);
  assert.equal(etimeToSeconds('01:53:35'), 6815);
  assert.equal(etimeToSeconds('2-01:00:00'), 176400);
  assert.equal(etimeToSeconds('garbage'), 0);
});

test('processes are classified by the most specific match', () => {
  const cases = [
    ['/x/node_modules/nx/src/daemon/server/start.js', 'nx-daemon'],
    ['/x/node_modules/nx/dist/daemon/server/start.js', 'nx-daemon'],
    ['/x/node_modules/nx/src/project-graph/plugins/w.js', 'nx-worker'],
    ['node /x/node_modules/@esbuild/darwin-arm64/bin/esbuild', 'esbuild'],
    ['node /x/node_modules/typescript/bin/tsc --noEmit', 'typescript'],
    ['node /x/node_modules/vitest/vitest.mjs run', 'test-runner'],
    ['/usr/local/bin/claude', 'claude'],
  ];
  for (const [cmd, want] of cases) assert.equal(classify(cmd), want, cmd);
});

test('the project path is extracted from the argument, not the node binary path', () => {
  const cmd = '/opt/homebrew/Cellar/node@24/bin/node /Users/me/Work/medone/node_modules/.pnpm/nx@21/x.js';
  assert.equal(projectFromCmd(cmd), '/Users/me/Work/medone');
});

test('a command with no node_modules yields no project', () => {
  assert.equal(projectFromCmd('node ./server.js'), null);
});
