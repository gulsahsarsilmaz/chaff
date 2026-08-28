---
description: Show what chaff would clean up, sorted by safety tier — changes nothing
allowed-tools: Bash(node:*)
---

Show the user this plan verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" plan --fresh $ARGUMENTS`

This is read-only. Explain the tiers briefly if the user has not seen them:

- **Tier 1 — dead.** The project, worktree, or parent process it belongs to no longer
  exists. Reclaiming it cannot affect anything you are working on.
- **Tier 2 — idle.** Safe, but not free: a stopped daemon restarts on demand, a deleted
  cache costs one cold rebuild, a pruned store costs a re-download.
- **Tier 3 — live.** Touches a running task or a worktree that may hold uncommitted work.
  Never applied automatically; entries marked `[locked]` or `[in use]` are never applied
  at all.

Do not apply anything. Point the user at `/chaff:clean` if they want to act.
