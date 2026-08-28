---
description: Set up, inspect, or remove unattended nightly cleanup
argument-hint: "[--install --hour=3] | [--uninstall]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" schedule $ARGUMENTS`

This installs a macOS launchd agent that runs `chaff clean --tier=2 --yes` on a schedule.

Before installing, make sure the user understands what tier 2 does unattended:
- stops idle build daemons (they restart on demand)
- deletes stale caches and stale build output (one cold rebuild each)
- removes worktrees that are **merged, clean, and idle** — never dirty ones
- prunes package-manager stores of unreferenced entries

Tier 3 cannot be scheduled; the command refuses it, because it can delete uncommitted work.

The job logs to `~/.chaff/nightly.log`. Suggest checking it after the first run.
