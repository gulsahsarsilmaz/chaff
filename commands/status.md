---
description: Live pressure on this machine — node processes, build daemons, caches, outputs, stores, worktrees
argument-hint: "[explain]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" *)
---

Run the scanner and show the user the result verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" scan --fresh`

If the user's arguments were `explain` ("$ARGUMENTS"), also run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/chaff.mjs" status --explain` and show that instead: it
appends a legend saying what each metric means and what trips it.

`$ARGUMENTS` is never placed in a shell command: read it yourself and pass only the exact flags listed here.

Then add at most three sentences of interpretation. Focus on:
- which single project is costing the most memory, and whether it has work in flight
- whether memory, disk, or worktree sprawl is the binding constraint right now
- if any nx project is below nx 22.7, note that worktree-aware caching and a ~7x daemon
  memory reduction landed there — below it, every worktree duplicates the whole cache

Do not propose or run cleanup. `/chaff:clean` is for that.
