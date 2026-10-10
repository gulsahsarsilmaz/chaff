---
description: View or change chaff policy, thresholds, roots, and protected paths
argument-hint: "[key=value]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" *)
---

Current configuration:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" config`

If the user's arguments ("$ARGUMENTS") contain a `key=value` for a key in the table below,
apply it with:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" config --set='<key=value>'`
Single-quote the whole `--set` argument, and refuse any value containing a quote, `;`, `&`,
`|`, `$` or a backtick.
`$ARGUMENTS` is never placed in a shell command: read it yourself and pass only the exact flags listed here.


| key | meaning |
| --- | --- |
| `policy` | `propose` (default, never acts alone) · `auto-orphans` (silently reaps tier 1) · `auto-threshold` (reaps tier 1+2 once a threshold trips) |
| `thresholds.nodeRssMb` | total toolchain memory (node, JVM, Unity, cargo…) before the statusline turns red. Defaults to ~35% of physical RAM (floor 4GB) so the warning means something on any machine |
| `thresholds.daemons` | concurrent build daemons before warning |
| `thresholds.diskFreeGb` | free-space floor |
| `thresholds.cacheGb` | build cache ceiling |
| `thresholds.worktrees` | worktree count ceiling |
| `thresholds.storeGb` | package-store size before pruning is offered |
| `staleArtifactDays` | days an artifact goes untouched before it counts as cold |
| `staleWorktreeDays` | days without a commit before a worktree counts as stale |
| `idleDaemonMinutes` | idle minutes before a daemon becomes tier-2 eligible |
| `abandonedWorkHours` | hours a build or dev server runs before it counts as abandoned rather than in flight |
| `includeOutputs` | also track `dist` / `build` / `.next`, not just caches |
| `roots` | JSON array of directories to scan, e.g. `["~/code","~/work"]`. Unset means inferred from the cwd — never inferred at or above `$HOME` |
| `statuslineStyle` | `color` (default, red/green metric text) · `dots` (emoji) · `plain` (no markers) |
| `protect` | JSON array of path substrings no tier may ever touch |
| `autoStatusline` | `true` (default) lets the plugin install chaff's statusline when you have none; `false` leaves your settings alone |

Explain the tradeoff before changing `policy`. Moving off `propose` means chaff acts
without asking.
