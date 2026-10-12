# Working on chaff — guide for AI coding agents

chaff deletes things on other people's machines. Every change is judged first on whether it
can destroy work a build cannot recreate; speed, tidiness and features come after. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before changing behaviour — its **safety invariants** are
enforced by tests and are not up for negotiation in a PR.

## Hard constraints

- **No runtime dependencies.** Node's standard library only. Never add anything to
  `dependencies` or `devDependencies`; there is no `npm install` step and none may be added.
- **Node >= 18, ESM, no build step.** Every file in `scripts/` must run straight from a
  checkout with `node`. No TypeScript, bundlers or transpilers.
- **macOS, Linux and Windows.** BSD and GNU `ps`/`du`/`find`/`df` disagree about flags and
  output; Windows has none of them and uses chaff's own scan layer. If you touch a shell-out
  or a path, account for all three. Use `path.sep`/`path.join`, never a hard-coded `/`.
- **Hooks never hard-fail.** `scripts/hook-*.mjs` read cached data and exit 0 on every error
  path. A hook that blocks a session or denies a build is a worse bug than what it guards.
- **Removal goes through the trash** (move + TTL + `chaff restore`), never `rm`. A new kind
  of cleanup goes through the trash too.
- **Missing information never makes something more removable.** Unknown = unsafe.

## Layout

| Path | What |
| --- | --- |
| `scripts/chaff.mjs` | The CLI and core: discovery, sizing, scan cache, `buildPlan`, `applyPlan`, trash, rendering, command dispatch. Also the npm `bin`. |
| `scripts/mcp.mjs` | MCP server (`chaff mcp`). Cleanup needs real user consent: elicitation or a fresh `planId`. Tier 3 is never reachable over MCP. |
| `scripts/plan-digest.mjs` | Fingerprint of a plan's actions; `chaff apply --expect` refuses if the plan changed. |
| `scripts/thresholds.mjs` | The one definition of "over the limit" (`breaches`) and the default thresholds. Plan, tiles, statusline and hook all use it — don't re-derive a limit elsewhere. |
| `scripts/update-check.mjs` | Daily, detached "newer version?" check; statusline/hook read only its cache. |
| `scripts/statusline-setup.mjs` | Installs/repoints the Claude Code statusline without touching anyone else's. |
| `scripts/hook-session-start.mjs`, `hook-pre-build.mjs` | Claude Code plugin hooks (see `hooks/hooks.json`). |
| `commands/*.md` | The plugin's slash commands. They must never place `$ARGUMENTS` in a shell command. |
| `.claude-plugin/` | Plugin and marketplace manifests. `plugin.json` `version` must equal `package.json`. |
| `packaging/homebrew/chaff.rb` | Reference copy; the live formula is in `gulsahsarsilmaz/homebrew-chaff`, which bumps itself. |
| `test/*.test.mjs` | `node:test`. One file per concern; `safety.test.mjs` holds the invariants. |

Detectors are data: build artifacts live in the `ARTIFACTS` table (keyed by directory name,
gated with `requires` on a sibling marker when the name is an ordinary word, relabelled with
`refine`), shared stores in `STORES` (`safe`, `prune`, `cost`, `rm`, `howTo`). Adding a
toolchain is usually a table entry plus a found/ignored test pair — see
`test/ecosystems.test.mjs`. Do **not** add new `PROJECT_MARKERS` for things that nest inside
other projects (`pubspec.yaml`, `Podfile`, `*.xcodeproj`): a nested project root detaches
build output from the processes that keep it live.

## Commands

```sh
npm test                          # full suite, under a minute, real filesystem work, no network
node --test test/<file>.test.mjs  # one file while iterating
node scripts/chaff.mjs plan       # read-only, safe anywhere
node scripts/chaff.mjs scan --fresh --json
```

Never run `reap`, `clean`, `apply` or `trash --empty` against a real machine to "try it" —
use a temp fixture.

## Writing tests

- Point state at a temp dir: `CHAFF_HOME=<tmp>` (config, caches, trash), and give the scan
  explicit `roots` in that dir's `config.json` — inferred roots are the checkout's parent,
  i.e. the developer's whole code folder. Never let a test touch the real `~/.chaff`.
- Unless the test is about stores, set `CHAFF_STORES=none`: `pnpm store path` ignores
  `$HOME`, so otherwise the test sizes the real multi-GB store (slow, machine-dependent).
  For tests that are about stores, set `HOME` and `XDG_CACHE_HOME` to a fixture instead.
- Build fixtures with `mkdtempSync` and real directories; give each detector a decoy with the
  same name and no marker, and assert it is ignored.
- Spawn the CLI with `spawnSync(process.execPath, [CLI, …], { env: { …, CI: '' } })` — `CI`
  changes behaviour (no progress, no update check).
- Output is pinned: `test/render.test.mjs` renders every screen from
  `test/fixtures/scan.json` and compares with `test/fixtures/render/*.txt`. If you change
  output on purpose, run `UPDATE_SNAPSHOTS=1 node --test test/render.test.mjs` and read the
  diff before committing. A snapshot diff in a refactor PR means behaviour changed.
- No network in tests. Fake servers bind to `127.0.0.1:0`.
- A new safety rule gets a line in CONTRIBUTING's invariants list and a test in
  `safety.test.mjs` (or the file named next to it).

## Style

- Comments explain **why** — the failure mode a line prevents — not what it does. Match the
  density around you; don't narrate.
- Small pure functions for decisions (`buildPlan`, `isNewer`, `parseListValue`); I/O at the
  edges. Exported for tests when a decision is worth pinning.
- User-facing text: plain sentences, the exact command to run next, no emoji in CLI output
  except the statusline's existing `dots` style.
- Every hint chaff prints must work when pasted into zsh and bash (no unquoted
  brackets or globs).

## Changes and PRs

- One concern per PR; add a bullet under `## Unreleased` in `CHANGELOG.md` for anything a
  user would notice.
- Never weaken a safety test to make a change pass. If an invariant blocks you, stop and ask.
- The repo merges PRs with merge commits after every check is green (macOS/Linux × Node
  18/20/22, `windows`, CodeQL). Don't merge with a failing or pending check.
- Releases are deliberate: bump `package.json`, `.claude-plugin/plugin.json` and the
  CHANGELOG heading together, merge, then push a `v*` tag. CI publishes to npm via trusted
  publishing; nobody publishes from a laptop. Plugin users only receive an update when the
  `plugin.json` version changes.
