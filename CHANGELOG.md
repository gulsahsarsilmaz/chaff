# Changelog

## Unreleased

### Added

- **chaff speaks MCP.** `chaff mcp` serves the protocol over stdio, so Codex, Cursor, Zed,
  Windsurf and anything else that speaks MCP gets the same tools the Claude Code plugin has:
  `chaff_status`, `chaff_plan`, `chaff_doctor`, `chaff_worktrees`, `chaff_reap` and
  `chaff_clean`. The four reporting tools are annotated read-only. `chaff_clean` requires
  `confirm: true`, and **tier 3 is not reachable over MCP at all** — it touches running
  processes and uncommitted code, and a model deciding that unattended is not a tradeoff worth
  making. Tier 3 stays a person at a terminal.
- **`--plain` for the statusline.** Strips ANSI, for consumers that do their own styling.
  tmux wants `#[fg=...]` and starship re-styles whatever a custom module prints; both mangled
  the coloured output. See `packaging/shell/` for tmux, starship, zsh, bash and fish snippets.
- **Homebrew packaging.** `packaging/homebrew/chaff.rb` plus tap instructions.
- **A release workflow.** Publishing runs on a tag, never on a merge, and refuses to ship
  unless the tag, `package.json`, `.claude-plugin/plugin.json` and the CHANGELOG all agree.

### Changed

- **Windows now refuses instead of pretending.** chaff's inventory comes from `find`, `du`,
  `df` and `ps`; on Windows those are missing or mean something else entirely (`find.exe`
  searches text *inside* files), so a scan returned almost nothing — and an empty inventory
  handed to a cleanup planner is the one failure this tool must never have. Every
  scan-dependent command now exits 4 with a message pointing at WSL. `help`, `config` and the
  MCP handshake still work. CI runs this on real `windows-latest`.

### Fixed

- **Path grouping no longer assumes a forward slash.** The cargo-duplication check in
  `doctor` keyed on `path.split('/')`, which on Windows-shaped paths collapsed every
  `target/` into one bucket.
- **A duplicated `## A note on nx` heading** in the README.

### Fixed

- **The low-disk build guard no longer prompts in an unattended session.** Below half your
  `diskFreeGb` floor, the `PreToolUse` guard asked for approval before a build — in `auto`,
  `acceptEdits` or `bypassPermissions` there is nobody there to answer, so it only stalled the
  run. It now reads `permission_mode` and allows in those modes, carrying the same warning text
  in the decision reason. Attended sessions still get the prompt.

## 0.2.0

### Changed — affects what cleanup offers

- **Language servers are daemons, not work in progress.** `rust-analyzer`, `gopls` and
  `omnisharp` were classified as one-shot compiles, which marked their project *active* and
  held its artifacts out of tier 2 for as long as an editor stayed open. They now count as
  daemons. Expect tier 2 to offer more than it used to on machines that keep an editor open.
- **Statusline drops metrics with nothing to report.** Daemon and worktree counts are omitted
  at zero rather than shown as a green `0d` / `0wt`. Memory, disk and junk always render —
  zero there is a real reading, not an absent concept.
- **`node memory` is now `toolchain mem`.** It has counted every toolchain — JVM, Unity,
  cargo, python — since toolchain attribution landed; only the label was still node-centric.
  The config key stays `thresholds.nodeRssMb`, so existing configs are unaffected.

### Added

- **`statuslineStyle`**: `color` (default — red/green on the metric itself), `dots` (the old
  emoji markers) or `plain`. `NO_COLOR` downgrades `color` to `plain`.
- **`chaff status --explain`** (`/chaff:status explain`): a legend giving each metric's
  meaning, the threshold that trips it, and where it stands now. Falls back to a stacked
  layout below 100 columns.
- **Tile row** at the top of `chaff status` on terminals 100 columns or wider; the bar
  layout is still used below that.

### Fixed

- **Inferred scan scope is now labelled.** With no `roots` configured, chaff infers them from
  the cwd — previously in silence, so a user could read "all clear" about a machine two
  thirds of which was never scanned. `status` shows a `scope` line and the statusline shows
  `⚠ cwd`.
- **No more home-directory crawls.** Inference refuses any root at or above `$HOME`, which
  previously meant a depth-6 walk of Library, Downloads and iCloud when a session started
  outside a repo. Processes and shared stores are still reported; project scanning is not.
- **One-time roots prompt.** On a machine with no config file, the SessionStart hook asks
  once — and only once — which directories hold the user's repos.
- **`doctor` no longer double-indents** the continuation lines of multi-line findings.
