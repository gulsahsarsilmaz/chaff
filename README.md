<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/gulsahsarsilmaz/chaff/main/assets/banner-dark.svg">
    <img alt="chaff — separate the live work from the dead weight" src="https://raw.githubusercontent.com/gulsahsarsilmaz/chaff/main/assets/banner-light.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gulsahsarsilmaz/chaff"><img alt="npm" src="https://img.shields.io/npm/v/@gulsahsarsilmaz/chaff?color=f0b545&label=npm"></a>
  <a href="https://github.com/gulsahsarsilmaz/chaff/actions/workflows/test.yml"><img alt="tests" src="https://github.com/gulsahsarsilmaz/chaff/actions/workflows/test.yml/badge.svg"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-7ee787">
  <img alt="node 18+" src="https://img.shields.io/badge/node-%E2%89%A518-79c0ff">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-d7dde3"></a>
  <a href="https://buymeacoffee.com/gulsahsarsilmaz"><img alt="Buy me a coffee" src="https://img.shields.io/badge/buy%20me%20a%20coffee-support-f0b545?logo=buymeacoffee&logoColor=white"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#install-as-a-claude-code-plugin">Claude Code plugin</a> ·
  <a href="#use-it-from-any-agent-mcp">MCP for any agent</a> ·
  <a href="#safety-model">Safety model</a> ·
  <a href="https://github.com/users/gulsahsarsilmaz/projects/1">Roadmap</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#support-chaff">Support</a>
</p>

---

**Welcome.** If your laptop fans are screaming, your disk is mysteriously full, and you have a
dozen agent worktrees you're afraid to delete — chaff is for you. It looks at everything your
toolchains leave behind, works out what is still alive, and tells you exactly what each
cleanup would cost before it touches anything.

## Quick start

You need **macOS or Linux** (on Windows, [run it inside WSL](#platform-support)) and
**Node 18 or newer**. No config, no dependencies.

Just want a look? This runs it without installing anything, and changes nothing:

```sh
cd ~/code/your-project      # run it from inside a project, not your home folder
npx @gulsahsarsilmaz/chaff plan
```

Keeping it:

```sh
npm install -g @gulsahsarsilmaz/chaff

chaff plan     # see what's reclaimable, sorted by tier. Changes nothing.
chaff reap     # reclaim tier 1 only: things whose owner no longer exists
```

The package name includes the scope: `npm install chaff` finds nothing.

Run from inside a project, chaff scans that repo and its siblings. Run from your home folder,
it scans no projects at all. To cover your whole machine from anywhere, point it at your code
folders once with `chaff config --set=roots=~/code` (several: `--set=roots=~/code,~/work`).
If it doesn't work first time, see [Troubleshooting](#troubleshooting).

<p align="center">
  <img alt="Example output of chaff plan, grouped into tier 1 dead, tier 2 idle and tier 3 live" src="https://raw.githubusercontent.com/gulsahsarsilmaz/chaff/main/assets/plan.svg" width="100%">
</p>

Like what you see? Add it to
[Claude Code](#install-as-a-claude-code-plugin) for a live statusline, or wire it into
[any MCP agent](#use-it-from-any-agent-mcp). Everything it deletes goes to a
[trash you can restore from](#undo).

## How it works

`chaff` finds every build process, daemon, cache, build output, package store and git
worktree across your projects — JS/TS, Rust, Go, .NET, JVM, Python, Unity, Unreal — works out
which are still alive, and sorts the rest into three tiers by how much it would hurt to
reclaim.

Built for the case where you have a dozen agent worktrees in flight, half a dozen build
daemons you didn't know were running, and no way to tell which is safe to kill.

## Why

`nx reset` clears one workspace at a time. `cargo clean` clears one crate. `ps | grep node`
tells you a process exists but not which project owns it or whether anything still needs it. `du -sh *` takes five minutes
and doesn't know what's regenerable. Orphan-process reapers don't understand build tools,
and none of them can tell an idle daemon from one with a build in flight.

chaff attributes every process to a project by walking the process tree in both directions,
sizes every regenerable artifact in one batched pass, ages every worktree by its last commit,
and tells you what each cleanup would actually cost you.

## The three tiers

| Tier | Meaning | What it costs |
| --- | --- | --- |
| **1 — dead** | The project, worktree, or parent process it belongs to no longer exists | Nothing. It is already garbage. |
| **2 — idle** | Nothing running against it, nothing touched it recently | One cold rebuild, or a re-download. |
| **3 — live** | Touches a running task, an active build, or uncommitted work | Potentially real work. Never automatic. |

Entries marked `[locked]`, `[in use]`, or `[building]` are shown but **never executed**, even
with `--force`.

## What it found on the machine it was built for

One laptop, mid-afternoon, during ordinary parallel agent work:

```
load average    713          →  7
nx daemons      6 (one at 646% CPU for 88 min, unnoticed)
node processes  68           →  11
git worktrees   111          →  50      (76 of them hidden in .claude/worktrees/)
disk free       36.5 GB      →  59 GB
```

And the things nothing was reporting at all:

```
76.5 GB   Cargo target dirs — 53.7 GB of it six copies of the same src-tauri/target
77.1 GB   node_modules across 40 installs, with a 0.1 GB pnpm store (not hardlinked)
14.2 GB   one iOS build directory
 4.1 GB   npm cache
```

## What it tracks

**Processes** — nx daemons and workers, turbo daemons, tsserver, watchman, metro, esbuild,
swc, tsc, jest/vitest/playwright/cypress, next/vite/webpack/nodemon/storybook/wrangler,
eslint/prettier/biome, plus JVM/Gradle daemons, dotnet/MSBuild/OmniSharp, Go, Cargo,
Python, Unity and Unreal editors. Each is attributed to the project that owns it.

**Build artifacts, by ecosystem**

| | cache | output |
| --- | --- | --- |
| JS/TS | `.nx` `.turbo` `.angular` `.parcel-cache` `.vite` `.rollup.cache` `.rspack-cache` `.webpack-cache` `.cache` | `.next` `.svelte-kit` `.astro` `.output` `.expo` `dist` `build` `coverage` `storybook-static` |
| Rust / JVM | `.gradle` | `target` |
| .NET | | `obj` |
| Python | `__pycache__` `.pytest_cache` `.mypy_cache` `.ruff_cache` `.tox` | |
| Unity | `Library` `Temp` | |
| Unreal | `Intermediate` `DerivedDataCache` | `Binaries` |
| Xcode / iOS | | `build` next to `*.xcodeproj`, `*.xcworkspace` or `Podfile` (labelled `xcode`) |

`target`, `obj`, `Library`, `Temp`, `Intermediate` and `Binaries` are ordinary words, so each
is **gated on a project marker** in the same directory — `Cargo.toml`, `*.csproj`,
`ProjectSettings` + `Assets`, `*.uproject`. Without the marker they are never counted, never
mind deleted. `bin/` is excluded outright: too many repos keep real scripts there.

**Shared stores** — pnpm, npm, yarn, Go module + build cache, NuGet, pip (all safely
prunable); Cargo registry, Gradle, Maven, Playwright and Puppeteer browsers and Xcode
`DerivedData` (surfaced, never auto-pruned, because re-downloading or rebuilding them is
expensive or offline-hostile; each is offered only at tier 3, with its real cost stated).

**Dependencies** — `node_modules`, counted once per install. Slow to measure, so it is
opt-in via `--full`, kept in its own 24-hour cache so an ordinary scan never destroys it,
and reported as `not measured` when absent rather than silently undercounting.

**Worktrees** — every `git worktree`, aged by last commit, with merged / dirty / locked /
in-use state. Primary checkouts are never proposed for removal.

Projects are found by marker: `nx.json`, `turbo.json`, `pnpm-workspace.yaml`, `lerna.json`,
`rush.json`, `Cargo.toml`, `go.mod`, `*.sln`, `*.csproj`, `build.gradle`, `pom.xml`,
`pyproject.toml`, `ProjectSettings`, `*.uproject`, or plain `.git`.

## What `chaff doctor` tells you

Not just what is big — what is *wrong*, and the command that fixes it:

- nx below 22.7, where every worktree duplicates the whole cache
- `node_modules` far larger than the pnpm store, meaning installs are not hardlinked
- the same Cargo `target/` compiled into N sibling checkouts, when `CARGO_TARGET_DIR`
  would share one
- daemon count, worktree count, the largest regenerable artifact, oversized shared stores

## Use it from any agent (MCP)

chaff speaks MCP over stdio, so anything that speaks the protocol — Codex, Cursor, Zed,
Windsurf, Claude Code — gets the same tools. Install it once, point your client at it.

```
npm install -g @gulsahsarsilmaz/chaff
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.chaff]
command = "chaff"
args = ["mcp"]
```

**Claude Code** — `claude mcp add chaff -- chaff mcp`, or the standard shape below in
`.mcp.json`.

**Cursor** (`~/.cursor/mcp.json`), **Zed**, **Windsurf** and anything else taking the
standard shape:

```json
{
  "mcpServers": {
    "chaff": { "command": "chaff", "args": ["mcp"] }
  }
}
```

From a checkout instead of a global install, use `"command": "node"` and
`"args": ["/path/to/chaff/scripts/chaff.mjs", "mcp"]`.

| Tool | Does | Safe? |
| --- | --- | --- |
| `chaff_status` | Memory, disk, cache, output, stores, daemons, worktrees | read-only |
| `chaff_plan` | What it would clean, by tier, with sizes | read-only |
| `chaff_doctor` | What is misconfigured, and the fix for each | read-only |
| `chaff_worktrees` | Every worktree, staleness, uncommitted work | read-only |
| `chaff_reap` | Reclaim tier 1 only — provably dead | safe |
| `chaff_clean` | Tier 1-2, to trash. Needs `confirm: true` | recoverable |

**Tier 3 is not reachable over MCP.** It touches running processes and uncommitted code,
and a model deciding that on its own — possibly auto-approved — is not a tradeoff worth
making. Tier 3 stays a person at a terminal: `chaff clean --tier=3 --yes --force`.

Everything `chaff_clean` removes goes to the chaff trash, recoverable with `chaff restore`
until the TTL expires.

## Install as a Claude Code plugin

```
/plugin marketplace add gulsahsarsilmaz/chaff
/plugin install chaff
```

Or from a local checkout:

```
/plugin marketplace add /path/to/chaff
/plugin install chaff
```

> **Your statusline sets itself up.** On the first session after install, chaff adds its
> live pressure readout to your Claude Code statusline — but only if you don't already have
> one. Yours is never replaced. `chaff statusline --uninstall` removes it for good.

| Command | Does |
| --- | --- |
| `/chaff:status` | Live pressure: memory, disk, cache, output, stores, daemons, worktrees |
| `/chaff:plan` | What it *would* clean, by tier. Read-only. |
| `/chaff:clean [1\|2\|3]` | Review, confirm, apply one tier. Checks worktrees for uncommitted work first. |
| `/chaff:reap` | Apply tier 1 only. Safe, no prompt. |
| `/chaff:worktrees [--dirty]` | Every worktree, its staleness, and exactly what is uncommitted in it |
| `/chaff:schedule` | Set up or remove unattended nightly cleanup |
| `/chaff:config [key=value]` | Policy, thresholds, roots, protected paths |

`/chaff:status explain` appends a legend — what each metric means, what trips it, and where
it stands right now. Worth running once: `2d` and `50wt` are not guessable.

On a terminal 100 columns or wider, `status` opens with a tile row; below that it falls back
to the bar layout, which says the same thing in less space.

CLI-only: `chaff top` (processes by memory, attributed to a project), `chaff doctor`
(what is wrong and what to do), `chaff help`.

### Hooks

- **SessionStart** — reads the cached scan and, if you are over a threshold, tells Claude so
  it can raise it when you complain the machine is slow. Never scans inline.
- **PreToolUse** — catches a build about to start when disk is below your floor, and says so
  before you wait twenty minutes for it to fail. Only fires on genuine build commands, never
  hard-denies, and reads the cache only.

### Unattended cleanup

```sh
chaff schedule --install --hour=3   # nightly tier 2 via launchd
chaff schedule                      # status
chaff schedule --uninstall
```

Tier 3 cannot be scheduled — the command refuses it, because it can delete uncommitted work.

### Is there a button?

No. Claude Code keybindings map only to a fixed set of built-in actions, and plugins cannot
add clickable UI. The nearest equivalents are `/chaff:clean` (autocompletes from `/ch`),
`chaff schedule --install` (nothing to press — it just runs), and `policy: auto-threshold`.

### Statusline — the point of the whole thing

Once the plugin is enabled you see machine pressure **while you work**, on every turn — no
setup step:

```
dev@laptop:~/work/chaff | Opus 5 | ctx:83%
chaff 8.3G/67p · 3d · 41.3G free · 37.1G junk · 98wt
```

`8.3G/67p` toolchain memory across 67 processes (node, JVM, Unity, cargo, python — not
just node) · `3d` build daemons · disk free · reclaimable cache+output · worktree count.
Each metric turns red as it crosses its threshold.

Daemon and worktree counts are **omitted when they are zero**: a codebase with no nx,
turbo, tsserver or language server running should not carry a permanent `0d`. Memory, disk
and junk always render — zero there is a real reading, not an absent concept.

Pick how a breach is marked with `statuslineStyle`:

| value | looks like |
| --- | --- |
| `color` (default) | the metric itself in red or green — `chaff 8.3G/67p · 3d · 41.3G free` |
| `dots` | emoji markers — `chaff 🔴 8.3G/67p · 🟢 3d · 🔴 41.3G free` |
| `plain` | no markers at all, for monochrome statuslines |

`NO_COLOR` in the environment downgrades `color` to `plain`.

**How the automatic setup behaves.** A Claude Code plugin cannot ship a statusline itself,
so chaff's session-start hook writes one into `~/.claude/settings.json` for you:

| You have… | chaff… |
| --- | --- |
| no statusline | installs its own, and says so once |
| chaff's, from an older plugin version | repoints it at the current install, so updates never break it |
| your own | **never touches it**, and tells you once how to add chaff underneath |
| a settings file it cannot parse | leaves the file exactly as it is |

To show chaff under a statusline of your own, add one line to your script — each `echo`
becomes its own row:

```sh
chaff statusline --stale=300        # with npm i -g @gulsahsarsilmaz/chaff
```

Without the plugin, `chaff statusline --install` does the same setup from a global install.
`chaff statusline --uninstall` removes it and sets `autoStatusline: false`, so the plugin
never puts it back.

**It stays instant.** The statusline runs on every update tick, so it never scans inline —
it reads a cached scan (~40ms) and spawns a detached rescan in the background only when the
cache is older than `--stale` seconds. A `↻` suffix means a refresh is in flight. Pair it
with `"refreshInterval": 15` so the numbers keep moving even while the session is idle.

## Standalone CLI

```sh
chaff scan                # inventory
chaff plan                # tiered plan, changes nothing
chaff reap                # tier 1 only
chaff clean --tier=2 --yes
chaff clean --tier=3 --yes --force
```

Flags: `--json` machine-readable · `--fresh` bypass the scan cache · `--deep` also size
`node_modules` · `--dry-run` show without acting.

## Configuration

`~/.chaff/config.json`:

```json
{
  "roots": ["~/code", "~/work"],
  "policy": "propose",
  "thresholds": {
    "nodeRssMb": 16384, "daemons": 4, "diskFreeGb": 60,
    "cacheGb": 3, "worktrees": 25, "storeGb": 10
  },
  "staleArtifactDays": 7,
  "staleWorktreeDays": 7,
  "idleDaemonMinutes": 90,
  "abandonedWorkHours": 24,
  "includeOutputs": true,
  "statuslineStyle": "color",
  "protect": []
}
```

With no `roots` set, chaff infers them from the current repo and its parent directory, so
sibling checkouts and worktrees are picked up automatically. An inferred scope is always
labelled — `scope  inferred from cwd` in `chaff status`, `⚠ cwd` on the statusline — because
repos outside that one tree are invisible to the scan, and an unlabelled "all clear" about
a third of a machine is worse than no scan at all.

chaff will not infer a root at or above `$HOME`: starting a session outside any repo would
otherwise walk Library, Downloads and iCloud six levels deep. It reports processes and
shared stores (which are machine-wide anyway) and tells you to set `roots` instead.

### Policies

- **`propose`** (default) — never acts alone. Everything goes through a command and a confirmation.
- **`auto-orphans`** — silently reaps tier 1 in the background at session start.
- **`auto-threshold`** — reaps tier 1 **and** tier 2 once a threshold trips. Tier 3 is still never automatic.

`protect` is an array of path substrings no tier may ever touch, regardless of policy.

## Safety model

- Every action re-verifies its precondition immediately before executing. A plan built
  seconds ago is not trusted to still be true.
- Primary git checkouts are never proposed for removal — only linked/agent worktrees.
- Locked, in-use, and actively-building targets are surfaced but never executed.
- Tier 2 requires `--yes`; tier 3 additionally requires `--force`.
- `/chaff:clean` runs `git status --porcelain` in each worktree before proposing removal and
  excludes dirty ones unless you name them.
- Browser caches are never pruned automatically.
- Build output with no recognisable project above it is never tier 1 or 2. Without a
  marker chaff cannot tell who owns it, so it is surfaced as a tier-3 decision for a person.
- A process is only killed as dead when it is a toolchain process attributed to a project
  inside your scanned roots — never a shell, an editor, or anything outside them.
- The `PreToolUse` hook never approves a command for you. It warns, or asks when disk is
  critical; your own permission rules decide the rest.

## Undo

`chaff` deletes things. Everything it removes is regenerable in principle, but the first
time you run a cleaner on your own machine "in principle" is not reassuring — so deletions
move to `~/.chaff/trash` instead of being unlinked.

```sh
chaff trash              # what was removed and can still be restored
chaff restore <id>       # put one back, byte for byte, at its original path
chaff trash --empty      # reclaim now
chaff clean --no-trash   # skip it, delete outright
```

Entries are auto-purged after `trashTtlDays` (7 by default). Restore refuses to overwrite
anything that has since taken the original path. Trashing is a rename, so it costs nothing —
except across filesystems, where a rename is impossible and chaff falls back to a real delete
rather than silently copying 20GB.

Worktree removal is not trashed: `git worktree remove` already refuses a dirty worktree, and
the branch and its commits survive regardless.

## Performance

- **One `find` per root**, `node_modules` pruned, one batched `du` across up to 150 paths at
  a time, one `ps`.
- **Incremental sizing.** Each directory's size is cached against its mtime, so an untouched
  build directory is never re-measured. A six-hour ceiling forces a re-measure regardless,
  because a write deep inside a subtree does not bump the root's mtime.

Measured on the machine in the numbers above — 251 projects, 50 worktrees, 460GB volume:

| | cold | warm |
| --- | --- | --- |
| `chaff scan` | 21.6s | **15.6s** |
| `chaff scan --full` (includes 77GB of node_modules) | 2m 39s | **22.7s** |
| `chaff statusline` | — | **~40ms** |

Plain `du -sh` over the same tree takes over five minutes and tells you nothing about what
is safe to delete.

The statusline never scans inline: it reads a cached scan and spawns a detached refresh only
when the cache is stale **and no scan is already running**. That last condition matters — an
earlier build of chaff omitted it, and the refresh tick stacked scans until the machine hit a
load average of 713. There is now a lock, and a test that holds it.

## Progress

A cold `--full` scan walks a very large tree. Silence for two minutes reads as a hang, so
chaff reports what it is doing on stderr — stdout stays clean and pipeable:

```
  sizing node_modules… 900/1501 (312 unchanged, reused)
```

Suppressed automatically under `--json`, `--quiet`, and in CI.

## CI runners

On a runner, disk is billed and a job that dies at 95% because the volume filled costs real
money. `CI=true` switches chaff to terse, parseable output automatically.

```sh
chaff ci                      # clean tier 2, one-line report, exit 0
chaff ci --strict             # exit 1 if still below the disk floor
chaff ci --json --tier=1      # machine-readable, provably-dead only
```

```json
{ "freedGb": 12.4, "diskFreeGb": 57.6, "belowFloor": true, "actions": 148,
  "outputGb": 102.05, "projects": 251, "worktrees": 50 }
```

## A note on nx

nx 22.7 introduced worktree-aware caching — one shared cache across all worktrees of a repo
instead of a full copy per worktree — and cut daemon memory roughly 7x. Below 22.7, every
agent worktree carries a complete `.nx` of its own. `chaff status` reports the nx version per
project so you can see which repos are paying that cost.

## Development

```sh
npm test          # no dependencies, no network
```

The suite is deliberately weighted toward the destructive paths. The invariants it pins:

- a worktree with uncommitted changes never reaches tier 2
- a worktree whose cleanliness is **unknown** never reaches tier 2 either (a `git status`
  timeout returns null, and null is treated as unsafe, not as clean)
- a primary checkout is never proposed for removal at any tier
- `applyPlan` never executes a `blocked` action, even at tier 3 with `--force`
- a dry run performs nothing
- the `protect` list is absolute
- the scan lock admits exactly one holder, is taken over when stale, and is never released
  by a process that does not own it
- a trashed entry is aged by its time in the trash, so the purge after a cleanup never
  destroys what that cleanup just trashed
- a malformed `--tier` is refused before anything is scanned or touched
- the `PreToolUse` hook never returns `allow`

`test/integration.test.mjs` builds a real git repo with merged, unmerged, and dirty
worktrees, so the git paths are exercised rather than mocked.

CI runs on ubuntu and macOS across Node 18/20/22, plus the Windows refusal, because chaff shells out to `ps`, `du`,
`df`, `find` and `git`, and those differ between BSD and GNU.

## Platform support

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| scan / plan / clean / trash | ✓ | ✓ | refuses — use WSL |
| scheduling | launchd | crontab | — |
| `help`, `config`, MCP handshake | ✓ | ✓ | ✓ |

chaff's inventory comes from `find`, `du`, `df` and `ps`, which Windows does not provide, so
every scan-dependent command exits 4 with a pointer to WSL rather than scanning nothing and
reporting all-clear. CI checks that refusal on a real `windows-latest` runner.

## Troubleshooting

**`npm install chaff` says 404.** The package is scoped: `@gulsahsarsilmaz/chaff`.

**"needs a POSIX scan layer … Run chaff inside WSL".** You're on native Windows. chaff runs
normally inside [WSL](https://learn.microsoft.com/windows/wsl/install); point it at your
WSL-side repos with `chaff config --set=roots=~/code`.

**"no project scan" and 0 projects.** You ran it from your home folder (or above it), where
chaff deliberately doesn't crawl. `cd` into a project, or set roots once:
`chaff config --set=roots=~/code`.

**`zsh: no matches found: --set=roots=[…]`.** zsh reads unquoted brackets as a file pattern.
Drop the brackets (`--set=roots=~/code,~/work`) or single-quote the JSON form
(`--set=roots='["~/code"]'`).

**`EACCES` on `npm install -g`.** Your global npm folder is owned by root. Use `npx
@gulsahsarsilmaz/chaff …`, or fix npm's prefix as in
[npm's guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally);
don't `sudo npm install`.

**An error before chaff prints anything.** Check `node --version`: chaff needs Node 18 or
newer.

**`chaff: command not found` after installing.** npm's global bin folder isn't on your
`PATH`. `npm prefix -g` shows where it is; add its `bin` to `PATH`, or use `npx`.

Still stuck? [Open an issue](https://github.com/gulsahsarsilmaz/chaff/issues/new/choose) with
your OS, `node --version`, the command you ran and its full output.

## Contributing

chaff is young and its scan covers a lot of ecosystems, so the most useful thing you can do is
run it on your machine and tell us what it got wrong. A wrongly classified process or a
missing artifact type is a great first issue.

- **Found a bug or a false positive?** [Open an issue](https://github.com/gulsahsarsilmaz/chaff/issues/new/choose) — `chaff status --json` output helps a lot.
- **Want to add an ecosystem?** Artifact types live in the `ARTIFACTS` table in
  `scripts/chaff.mjs`; see [CONTRIBUTING.md](CONTRIBUTING.md) for the bar a destructive tool has to clear.
- **Curious what's next?** The [public roadmap](https://github.com/users/gulsahsarsilmaz/projects/1)
  shows what's planned, in progress and done.
- **Security issue?** Please follow [SECURITY.md](SECURITY.md) rather than filing publicly.

Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).

### Support chaff

<a href="https://buymeacoffee.com/gulsahsarsilmaz">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/gulsahsarsilmaz/chaff/main/assets/support-dark.svg">
    <img alt="Enjoying chaff? Buy me a coffee" src="https://raw.githubusercontent.com/gulsahsarsilmaz/chaff/main/assets/support-light.svg" width="100%">
  </picture>
</a>

chaff is free, open source and built in spare time. If it gave you back a few gigabytes, a
quieter laptop or an afternoon you'd have spent hunting down rogue daemons,
[a coffee](https://buymeacoffee.com/gulsahsarsilmaz) genuinely keeps it going. Starring the repo
and telling a friend help just as much. Thank you.

## License

MIT — see [LICENSE](LICENSE).
