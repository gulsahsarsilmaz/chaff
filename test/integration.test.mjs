/**
 * Exercises the real git code paths against a repo built on the fly. Synthetic scan objects
 * cannot catch a wrong `git` invocation or a porcelain-parsing mistake.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultBranchFor, mergedBranches, isDirty } from '../scripts/chaff.mjs';

let repo;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

before(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'chaff-git-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'chaff test');
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git('add', '-A'); git('commit', '-m', 'initial');

  // a branch merged back into main
  git('branch', 'feat/merged');
  git('checkout', 'feat/merged');
  writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', '-A'); git('commit', '-m', 'merged work');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feat/merged', '-m', 'merge');

  // a branch that was never merged
  git('checkout', '-b', 'feat/unmerged');
  writeFileSync(path.join(repo, 'c.txt'), 'c\n');
  git('add', '-A'); git('commit', '-m', 'unmerged work');
  git('checkout', 'main');
});
after(() => rmSync(repo, { recursive: true, force: true }));

test('the default branch is detected without an origin remote', () => {
  assert.equal(defaultBranchFor(repo), 'main');
});

test('merged branches are distinguished from unmerged ones', () => {
  const merged = mergedBranches(repo, 'main');
  assert.ok(merged.has('feat/merged'), 'a merged branch must be recognised');
  assert.ok(!merged.has('feat/unmerged'), 'an unmerged branch must never look merged');
});

test('isDirty reports clean and dirty accurately', () => {
  assert.equal(isDirty(repo), false, 'a committed tree is clean');
  writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  assert.equal(isDirty(repo), true, 'a modified tracked file is dirty');
  git('checkout', '--', 'a.txt');
  assert.equal(isDirty(repo), false);
  writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
  assert.equal(isDirty(repo), true, 'an untracked file counts as dirty — it is unsaved work');
  rmSync(path.join(repo, 'untracked.txt'));
});

test('a worktree with uncommitted work is detected as dirty through the real git path', () => {
  const wt = path.join(repo, 'wt-dirty');
  git('worktree', 'add', wt, 'feat/unmerged');
  assert.equal(isDirty(wt), false);
  writeFileSync(path.join(wt, 'scratch.txt'), 'unsaved\n');
  assert.equal(isDirty(wt), true, 'this is the check that protects real work');
  git('worktree', 'remove', '--force', wt);
});

test('git refuses to remove a dirty worktree without --force', () => {
  const wt = path.join(repo, 'wt-guard');
  git('worktree', 'add', wt, '-b', 'feat/guard');
  writeFileSync(path.join(wt, 'scratch.txt'), 'unsaved\n');
  assert.throws(() => git('worktree', 'remove', wt),
    'chaff relies on this refusal as its last line of defence');
  git('worktree', 'remove', '--force', wt);
});
