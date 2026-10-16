---
name: chaff
description: Find and safely reclaim memory and disk a developer machine is wasting — stray build daemons, stale caches, dead build output, oversized package stores, abandoned git worktrees. Use when the disk is full or nearly full, a build or install fails with ENOSPC / "no space left on device", the machine is slow or swapping, many node/tsserver/gradle/nx processes are running, the user asks what is taking up space, or asks to clean up worktrees, caches, node_modules or target directories.
---

# chaff

chaff separates live work from dead weight on a developer machine and cleans up in safety
tiers. Everything it removes goes to a trash that `chaff restore` can undo.

## Which interface to use

1. **MCP tools** (`chaff_status`, `chaff_plan`, `chaff_doctor`, `chaff_worktrees`,
   `chaff_reap`, `chaff_clean`) if the chaff MCP server is connected. Prefer these.
2. **Claude Code plugin**: `/chaff:plan`, `/chaff:clean`, `/chaff:status`.
3. **CLI**: `chaff <command>`, or `npx @gulsahsarsilmaz/chaff <command>` when it is not
   installed. The npm package is scoped; `npm install chaff` is a different package.

## The tiers

- **Tier 1, dead.** The project, worktree or parent process it belonged to is gone.
  Removing it costs nothing.
- **Tier 2, idle.** Nothing running, nothing touched it recently. Costs a cold rebuild,
  a daemon restart or a re-download.
- **Tier 3, live.** Running tasks, active builds, worktrees that may hold uncommitted work.
  Costs real work.

## How to work

1. **Look first.** Run `chaff_status` / `chaff status` to see the pressure, then
   `chaff_plan` / `chaff plan` to see what would be cleaned. Both change nothing.
2. **Show the user the plan** — the tiers, the targets and the sizes — before anything is
   removed. Use `chaff_doctor` / `chaff doctor` when the cause looks like misconfiguration
   (for example every worktree duplicating a whole cache).
3. **Tier 1** may be reclaimed with `chaff_reap` / `chaff reap` once you have told the
   user what it will do.
4. **Tier 2 needs the user's explicit agreement.** Over MCP, call `chaff_clean` with
   `tier: 2`; chaff asks the user itself when the client supports it, otherwise pass the
   `planId` from the `chaff_plan` output the user saw. On the CLI, show
   `chaff clean --tier=2 --dry-run` first, then run `chaff clean --tier=2 --yes` only after
   they agree.
5. **Report the real result**: re-run status and give before and after, including
   anything skipped or failed.

## Rules

- Never apply tier 3 yourself. It is not available over MCP on purpose. If the user wants
  it, give them the command to run in their own terminal:
  `chaff clean --tier=3 --yes --force`, and tell them it may interrupt running work.
- Never widen the tier beyond what the user agreed to, and never pass a `planId` from a
  plan the user has not seen.
- Before suggesting a worktree be removed, check it with `chaff_worktrees` /
  `chaff worktrees --dirty` and name every one with uncommitted changes.
- Entries marked `[locked]`, `[in use]` or `[building]` are never removed. Do not try to
  work around that with `rm`, `git worktree remove` or `kill`.
- Do not delete what chaff reports with `rm -rf` yourself. chaff's value is the
  re-checks it makes just before acting and the trash it moves things to.
- To undo, `chaff trash` lists what can be restored and `chaff restore <id>` puts one
  back.
