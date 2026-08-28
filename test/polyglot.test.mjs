/**
 * Marker gating. "Library", "target" and "obj" are ordinary English words, so counting them
 * unconditionally would eventually mean deleting somebody's source tree. These fixtures pin
 * the gate: the artifact is only recognised when the sibling project marker is really there.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let root, home;
const CHAFF = path.resolve('scripts/chaff.mjs');

const make = (rel, files = [], dirs = []) => {
  const d = path.join(root, rel);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(path.join(d, f), 'x');
  for (const x of dirs) mkdirSync(path.join(d, x), { recursive: true });
  return d;
};

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'chaff-poly-'));
  home = mkdtempSync(path.join(tmpdir(), 'chaff-poly-home-'));

  // real projects — the artifact should be counted
  make('rust-real',  ['Cargo.toml'], ['target']);
  make('unity-real', [], ['ProjectSettings', 'Assets', 'Library']);
  make('dotnet-real',['App.csproj'], ['obj']);

  // decoys — same directory names, no project marker. Must NOT be counted.
  make('not-rust',  ['README.md'], ['target']);
  make('not-unity', ['README.md'], ['Library']);
  make('not-dotnet',['README.md'], ['obj']);

  writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    roots: [root], sizeMode: 'fast', maxScanDepth: 4, maxArtifactDepth: 4,
  }));
});
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const scan = () => JSON.parse(execFileSync(process.execPath, [CHAFF, 'scan', '--fresh', '--json'],
  { encoding: 'utf8', env: { ...process.env, CHAFF_HOME: home }, maxBuffer: 64 * 1024 * 1024 }));

test('marker-gated artifacts are found in real projects', () => {
  const paths = scan().projects.flatMap((p) => p.artifacts).map((a) => a.path);
  for (const want of ['rust-real/target', 'unity-real/Library', 'dotnet-real/obj']) {
    assert.ok(paths.some((p) => p.endsWith(want)), `${want} should be detected`);
  }
});

test('identically named directories WITHOUT a project marker are never counted', () => {
  const paths = scan().projects.flatMap((p) => p.artifacts).map((a) => a.path);
  for (const decoy of ['not-rust/target', 'not-unity/Library', 'not-dotnet/obj']) {
    assert.ok(!paths.some((p) => p.endsWith(decoy)),
      `${decoy} has no project marker and must never be treated as a build artifact`);
  }
});

test('bin/ is never treated as a build artifact', () => {
  // Too many repos keep real scripts in bin/ for it to be safe, even in a .NET project.
  make('dotnet-bin', ['App.csproj'], ['bin']);
  const paths = scan().projects.flatMap((p) => p.artifacts).map((a) => a.path);
  assert.ok(!paths.some((p) => p.endsWith('dotnet-bin/bin')));
});

test('projects are recognised across ecosystems, not just JS', () => {
  const kinds = new Set(scan().projects.flatMap((p) => p.kinds));
  for (const k of ['Cargo.toml', 'ProjectSettings']) {
    assert.ok([...kinds].some((x) => x.includes(k.replace('.toml', '')) || x === k),
      `expected a marker for ${k}, got ${[...kinds].join(', ')}`);
  }
});
