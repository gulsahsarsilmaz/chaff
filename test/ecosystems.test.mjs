/**
 * Toolchains beyond the original set. Each one is a found/ignored pair: the artifact counts
 * next to its project marker, and an identically named directory without one is left alone.
 * Machine-wide stores are reported for their size but never offered for automatic pruning.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let root, home, chaffHome, result;
const CHAFF = path.resolve('scripts/chaff.mjs');

const make = (rel, files = [], dirs = []) => {
  const d = path.join(root, rel);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(path.join(d, f), 'x');
  for (const x of dirs) mkdirSync(path.join(d, x), { recursive: true });
  return d;
};

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'chaff-eco-'));
  home = mkdtempSync(path.join(tmpdir(), 'chaff-eco-home-'));
  chaffHome = mkdtempSync(path.join(tmpdir(), 'chaff-eco-state-'));

  // Xcode: a React Native app's ios/ (Podfile), and a native app (*.xcodeproj is a directory)
  make('rn-app', [], ['.git', 'ios/build']);
  writeFileSync(path.join(root, 'rn-app', 'ios', 'Podfile'), 'x');
  make('native-app', [], ['.git', 'App.xcodeproj', 'build']);
  make('web-app', ['package.json'], ['.git', 'build']);

  mkdirSync(path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData', 'App-abc'), { recursive: true });

  writeFileSync(path.join(chaffHome, 'config.json'), JSON.stringify({
    roots: [root], sizeMode: 'fast', maxScanDepth: 4, maxArtifactDepth: 4,
  }));
  const run = (sub) => JSON.parse(execFileSync(process.execPath, [CHAFF, sub, '--fresh', '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: home, CHAFF_HOME: chaffHome, XDG_CACHE_HOME: path.join(home, '.cache') },
  }));
  result = { scan: run('scan'), plan: run('plan') };
});
after(() => { for (const d of [root, home, chaffHome]) rmSync(d, { recursive: true, force: true }); });

const artifact = (suffix) => result.scan.projects.flatMap((p) => p.artifacts).find((a) => a.path.endsWith(suffix));
const actions = () => result.plan.actions ?? result.plan;

test('ios/build next to a Podfile is reported as Xcode output', () => {
  assert.equal(artifact(path.join('rn-app', 'ios', 'build'))?.tool, 'xcode');
});

test('build/ next to an .xcodeproj is reported as Xcode output', () => {
  assert.equal(artifact(path.join('native-app', 'build'))?.tool, 'xcode');
});

test('an ordinary build/ keeps its generic label', () => {
  assert.equal(artifact(path.join('web-app', 'build'))?.tool, 'build');
});

test('Xcode DerivedData is reported as a store, not auto-prunable', () => {
  const st = result.scan.stores.find((s) => s.name === 'xcode DerivedData');
  assert.ok(st, 'DerivedData should be listed');
  assert.equal(st.safe, false);
  assert.equal(st.prune, null);
});

test('DerivedData is only ever a tier 3 action, with the real cost stated', () => {
  const dd = actions().filter((a) => a.target?.includes(path.join('Xcode', 'DerivedData')));
  assert.ok(dd.length, 'expected a tier 3 rm-store action for DerivedData');
  for (const a of dd) {
    assert.equal(a.tier, 3);
    assert.match(a.reason, /rebuild of every Xcode project/);
  }
});
