---
description: Immediately reclaim only provably-dead resources (tier 1) — safe, no prompts
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" *)
---

Apply tier 1 only. Every tier-1 target is dead by definition: the project directory,
worktree, or parent process it belongs to no longer exists, so reclaiming it cannot affect
running work.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" reap --fresh`

Report what was reclaimed in a line or two. If nothing was, say so plainly. If tier 2 or 3
has meaningful headroom, mention the number and point at `/chaff:clean` — but do not apply it.
