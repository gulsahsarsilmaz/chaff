# Changelog

## 0.3.4

- **Homebrew.** `brew install gulsahsarsilmaz/chaff/chaff`. The tap follows each release by
  itself, after verifying and test-installing it on macOS and Linux.
- **For contributors.** The 2,800-line `scripts/chaff.mjs` is now a thin entry over focused
  modules in `scripts/lib/`; every screen chaff prints is pinned by snapshot tests; the suite
  is hermetic and about three times faster; [AGENTS.md](AGENTS.md) guides AI-assisted work.
- **`config --set` no longer writes every default into your config.** It saved the whole
  merged config, which pinned defaults there for good: the memory threshold that scales with
  your RAM, and any default a later release improves. It now stores only the key you set
  (as does `statusline --install/--uninstall`). To undo the pinning on an existing config,
  delete the keys you never chose from `~/.chaff/config.json`.
- **A mistyped command fails straight away** instead of after a full scan, and a malformed
  JSON value in `config --set` says so instead of printing a stack trace.
- **One answer to "is this machine over its limits?"** The plan, the status tiles, the
  statusline and the Claude Code session warning now share it. They disagreed: the plan
  counted build cache alone against `cacheGb` while everything on screen counted cache plus
  output, and the session warning used a fixed 4GB memory limit instead of the default that
  scales with your RAM. `cacheGb` now means cache + output everywhere, so if you use
  `policy: auto-threshold`, its tier-2 cleanup can start a little sooner than before.
- **Trash keeps its promise across filesystems.** Trashing a directory on a different
  filesystem from chaff's trash used to fall back to a permanent delete and report "done".
  It now copies, verifies the copy and only then removes the original; if that fails,
  nothing is deleted. Trash entry names are also safe on every filesystem (a Windows drive
  colon used to make the name illegal), and restore always uses the exact recorded path.
- **Update notices.** Once a day, in the background, chaff checks npm for a newer release.
  The statusline shows `↑x.y.z` until you update, the Claude Code plugin announces it once
  per version at session start with the exact update steps, and `chaff version` prints the
  command for how you installed it (plugin, npm, Homebrew or npx). Off with
  `"updateCheck": false`, `CHAFF_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`, and never in CI.
- **Native Windows** ([#16](https://github.com/gulsahsarsilmaz/chaff/issues/16)). chaff now
  runs fully on Windows, no WSL needed. It scans through a layer of its own (a filesystem
  walk with `find`'s rules, PowerShell for processes, `statfs` for disk), and cleans up with
  Windows-specific care: a directory held open is skipped, never deleted; a move across
  drives is copied and verified before the original is removed; links are unlinked, never
  followed; `taskkill` runs only after the pid's command line and start time are re-checked;
  nightly cleanup uses Task Scheduler. Worktrees are never offered for removal on Windows,
  because chaff can't see which directory a process is working in.

## 0.3.3

- **Published from CI with npm trusted publishing**, so every release carries a provenance
  attestation linking it to the exact commit and workflow that built it.
- **Setting roots works in any shell.** The hint chaff printed for a first run,
  `chaff config --set=roots=["~/code"]`, failed as typed: zsh rejected it with
  `no matches found`, and bash stripped the quotes so chaff crashed parsing `[~/code]`. Roots
  and protected paths now take a plain comma list (`--set=roots=~/code,~/work`), the JSON
  form still works, and every hint uses the form that survives a shell.
- **The "no project scan" notice says what to do in the terminal**, not only as a Claude
  Code slash command.
- **The README says what chaff needs up front** (macOS or Linux, WSL on Windows, Node 18+),
  leads with `npx`, and has a Troubleshooting section for the ways a first run goes wrong.
- **Xcode.** `~/Library/Developer/Xcode/DerivedData` is reported as a shared store (tier 3
  only, never automatic), and a `build/` next to an `.xcodeproj`, `.xcworkspace` or
  `Podfile` (a React Native or Expo `ios/build`) is labelled as Xcode's.
- **Dart / Flutter and Zig.** `.dart_tool` (next to `pubspec.yaml`), `.zig-cache`,
  `zig-cache` and `zig-out` (next to `build.zig`) are recognised, Flutter's `build/` is
  labelled as Flutter's, and the Dart pub cache and Zig global cache are reported as stores.
- **Bazel output bases are reported, never removed.** chaff lists their size and points at
  `bazel clean --expunge`; it never proposes an `rm -rf` of a read-only Bazel tree.
- **Tier 3 store removals state their real cost.** Every store chaff won't prune on its own
  used to say deleting it meant "re-downloading browser binaries", including the Cargo
  registry and the Maven repository.
- **`chaff_clean` over MCP now needs consent from a person, not just the model.** When the
  client supports elicitation, chaff asks the user directly and runs nothing unless they
  accept. Otherwise it needs the `planId` from a recent `chaff_plan` (valid 10 minutes,
  single use) and dry-runs without one. Either way it applies only the plan that was agreed
  to: if the plan changed in between, it refuses. The new `chaff apply --expect=<digest>`
  enforces that in the CLI.
- **Faster cold scans.** Shared package stores (pnpm store, npm cache, Cargo registry…) are
  re-sized at most once a day instead of on every scan, which takes roughly a third off a
  cold scan. `--deep` re-measures them. A prune offered on a reused size is re-measured
  before it runs, and skipped if the store has dropped under the threshold.

## 0.3.2

- **Support chaff.** If chaff saves you time, you can now
  [buy me a coffee](https://buymeacoffee.com/gulsahsarsilmaz). The link shows in `npm fund`,
  on the repo's Sponsor button and in the README.
- **A public [roadmap](https://github.com/users/gulsahsarsilmaz/projects/1)** shows what's
  planned, in progress and done.
- **Issue forms** for bug reports, false positives, new toolchains, features and docs, with
  questions and ideas in [Discussions](https://github.com/gulsahsarsilmaz/chaff/discussions).
- **A read-only `settings.json` is left alone.** The statusline setup used to replace it
  anyway, because a rename ignores the file's permissions. A failed write no longer leaves a
  temp file behind, and `chaff statusline --install` reports a failure in plain words.

## 0.3.1

- **chaff now lives at [github.com/gulsahsarsilmaz/chaff](https://github.com/gulsahsarsilmaz/chaff).**
  The repository, issue, security and plugin-marketplace links all point there. The old
  previous addresses redirect, so nothing that already links to them breaks.
  Install the Claude Code plugin with `/plugin marketplace add gulsahsarsilmaz/chaff`.

## 0.3.0

**Published as [`@gulsahsarsilmaz/chaff`](https://www.npmjs.com/package/@gulsahsarsilmaz/chaff).**
npm reserves names too close to existing packages, and `chaff` sits next to `chai` and
`chalk`. Install with `npm i -g @gulsahsarsilmaz/chaff`; the command is still `chaff`.

### Added

- **The statusline sets itself up.** A plugin cannot ship a statusline — Claude Code drops
  that key from plugin settings — so the one in `settings.json` never applied. The
  SessionStart hook now installs chaff's into `~/.claude/settings.json` when there is none,
  repoints it after a plugin update, and never touches a statusline of your own or a
  settings file it cannot parse. `chaff statusline --install` / `--uninstall` do the same by
  hand; uninstalling sets `autoStatusline: false` so it stays gone.
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

- **Committed directories are never cleaned.** `build/` and `dist/` are ordinary names:
  golang-standards keeps Dockerfiles in `build/`, GitHub Actions repos commit `dist/`. Anything
  git tracks inside an artifact now keeps it out of every tier.
- **Long-running apps are not stopped for their age.** Tier 2 reaps only dev tooling that
  restarts in seconds — dev servers, bundlers, test runners, linters, compilers. A Unity or
  Unreal editor, a `dotnet run`, a Jupyter server or a `cargo run` app is left alone, and a
  bare `java` process is now an app rather than a build daemon.
- **A recycled pid is never signalled.** Every kill records the command each pid was running
  when planned, and is skipped if the pid now belongs to something else.
- **A shell or an editor in a worktree counts as someone working there**, through symlinks
  too, so that worktree is never offered for removal.
- **`chaff ci` refuses off a CI runner** unless given `--yes` or `--dry-run`: it deletes
  without the trash.
- **`restore` needs an exact id or a unique prefix**, instead of restoring the newest match.
- **A string where config expects a list** (`roots`, `protect`) is read as a one-item list
  rather than crashing; anything else is ignored with a warning.
- **Slash commands never put your arguments in a shell command**, and may only run chaff
  itself, rather than any `node` invocation.
- **An installed `chaff` did nothing.** npm installs the bin as a symlink, and the entry
  point compared `argv[1]` (the link) against `import.meta.url` (its target), so every global
  install and every `npx chaff` exited 0 without running. Running from a checkout hid it. The
  check now compares real paths, and CI installs the packed tarball and runs the bin.
- **The `bin` path is in the form current npm accepts.** npm 11 rejected `./scripts/chaff.mjs`
  and silently dropped the `chaff` command from the published package.
- **Path grouping no longer assumes a forward slash.** The cargo-duplication check in
  `doctor` keyed on `path.split('/')`, which on Windows-shaped paths collapsed every
  `target/` into one bucket.
- **A duplicated `## A note on nx` heading** in the README.
- **The trash kept nothing.** Entries were aged by the trashed directory's own mtime, which
  a rename preserves — and tier 2 only trashes things untouched for `staleArtifactDays`, so
  the purge that follows every cleanup deleted them in the same run. Age is now time in the
  trash, read from the `.origin` sidecar.
- **Paths with spaces no longer get the wrong process killed.** A project is read from a
  command line, which stops at the first space: VS Code's bundled tsserver became
  `/Contents/Resources/app/extensions`, which does not exist, so tier 1 killed it as dead —
  and, through tree propagation, its parent too. Attributions outside the scanned roots are
  now discarded, and tier 1 only kills toolchain processes, never a shell or an editor.
- **Build output with no recognisable project is tier 3, not tier 1.** No marker above a
  `dist/` means chaff cannot tell who owns it, not that the owner is dead. A plain npm project
  without `.git`, a project deeper than `maxScanDepth`, a sibling folder under an inferred
  root — all were "provably dead". They are now a decision for a person.
- **A malformed `--tier` is refused.** `--tier=all` parsed to `NaN`, which skipped the `--yes`
  and `--force` checks and applied every tier. `clean`, `apply`, `ci` and `schedule` now exit 2
  on anything but 1, 2 or 3, before scanning.
- **The low-disk build guard never approves a command.** It returned `allow` whenever disk was
  under the floor, which skipped the user's permission prompt for the whole command — not just
  the build in it. It now asks when disk is critical and someone is watching, and otherwise
  only warns.
- **MCP tool descriptions say what the tools do.** `chaff_reap` was marked non-destructive and
  "safe to run without asking" although it stops processes and deletes files; `chaff_clean`
  claimed everything went to the trash when stopped processes, removed worktrees and pruned
  stores do not.

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
