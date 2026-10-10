---
description: Review and apply chaff cleanup, one safety tier at a time
argument-hint: "[1|2|3] (default 1)"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" *), Bash(git -C * status --porcelain)
---

The user wants to reclaim memory and disk. Work through this in order.

1. Build the plan and show it to them:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" plan --fresh`

2. Read the tier from `$ARGUMENTS`, defaulting to **1**.

3. Dry-run that tier so they see the exact list before anything happens:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" clean --tier=<N> --dry-run`

4. **Ask for explicit confirmation before applying.** State plainly what is lost:
   - tier 1: nothing — these targets are already dead
   - tier 2: daemons restart on demand; caches cost one cold rebuild; pruned stores
     cost a re-download on the next install
   - tier 3: **may interrupt a running task or delete uncommitted work.** Before proposing
     any `remove-worktree`, check each one with `git -C <path> status --porcelain`. Report
     every worktree that is dirty and exclude it unless the user names it explicitly.

5. Only after confirmation:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" clean --tier=<N> --yes`
   (tier 3 additionally requires `--force`.)

6. Re-scan and report the real before/after — memory freed, disk freed, daemons stopped —
   including anything that failed or was skipped.

Never widen the tier beyond what the user asked for.
