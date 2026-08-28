---
description: Every git worktree, how stale it is, and exactly what is uncommitted in it
argument-hint: "[--dirty]"
allowed-tools: Bash(node:*)
---

Show the user this verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" worktrees $ARGUMENTS`

Agent worktrees live in `<repo>/.claude/worktrees/` and are invisible to `ls`, so people are
routinely surprised by how many they have.

Help them triage, and be precise about what each state means:
- **merged + clean** — safe to remove; every commit is already on the mainline.
- **merged + uncommitted** — the commits are safe, the uncommitted changes are not.
  Offer to `git stash push -u` or commit before removing.
- **UNMERGED** — removing the worktree still keeps the branch and its commits. Only
  uncommitted changes are lost. Say this plainly; people assume otherwise and it makes them
  hoard worktrees they don't need.
- **locked / in use** — leave alone.

Never remove a worktree with uncommitted changes unless the user names it explicitly and
confirms. Never pass `--force` to `git worktree remove` on your own initiative.
