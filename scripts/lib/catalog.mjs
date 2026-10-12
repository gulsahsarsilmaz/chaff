/**
 * What chaff knows about the world, as data: which files mark a project, which directories
 * are regenerable build output, which machine-wide stores exist and what removing each costs,
 * and how to recognise a toolchain process from its command line. Teaching chaff a new
 * toolchain is an entry here plus a found/ignored test pair (test/ecosystems.test.mjs).
 */
import path from 'node:path';
import { paths, IS_WIN, firstExisting, userName } from './paths.mjs';
import { run } from './exec.mjs';

// ── what counts as a project, and what each project leaves behind ──────────────

/** Files whose presence marks a directory as the root of a JS/TS project. */
export const PROJECT_MARKERS = [
  'nx.json', 'turbo.json', 'pnpm-workspace.yaml', 'lerna.json', 'rush.json',  // JS/TS
  'Cargo.toml',                                                               // Rust
  'go.mod',                                                                   // Go
  '*.sln', '*.csproj',                                                        // .NET
  'build.gradle', 'build.gradle.kts', 'pom.xml',                              // JVM
  'pyproject.toml',                                                           // Python
  'ProjectSettings', '*.uproject',                                            // Unity / Unreal
  '.git',                                                                     // anything else
];

/**
 * Regenerable artifacts, by directory name.
 *   cache  — pure cache. Deleting costs a slower next build, nothing else.
 *   output — build output. Regenerable, but something may currently be serving it.
 */
export const ARTIFACTS = {
  // ── JavaScript / TypeScript ────────────────────────────────────────────────
  '.nx':             { category: 'cache',  tool: 'nx' },
  '.turbo':          { category: 'cache',  tool: 'turbo' },
  '.angular':        { category: 'cache',  tool: 'angular' },
  '.parcel-cache':   { category: 'cache',  tool: 'parcel' },
  '.vite':           { category: 'cache',  tool: 'vite' },
  '.rollup.cache':   { category: 'cache',  tool: 'rollup' },
  '.rspack-cache':   { category: 'cache',  tool: 'rspack' },
  '.webpack-cache':  { category: 'cache',  tool: 'webpack' },
  '.cache':          { category: 'cache',  tool: 'generic' },
  '.next':           { category: 'output', tool: 'next' },
  '.svelte-kit':     { category: 'output', tool: 'sveltekit' },
  '.astro':          { category: 'output', tool: 'astro' },
  '.output':         { category: 'output', tool: 'nitro' },
  '.expo':           { category: 'output', tool: 'expo' },
  'dist':            { category: 'output', tool: 'build' },
  // `refine` only relabels: an iOS app's ios/build is the same ungated build/ as ever, but
  // reported as Xcode's so the breakdown says what made it.
  'build':           { category: 'output', tool: 'build', refine: [
    { tool: 'xcode', requires: ['*.xcodeproj', '*.xcworkspace', 'Podfile'] },
    { tool: 'flutter', requires: ['pubspec.yaml'] },
  ] },
  'coverage':        { category: 'output', tool: 'coverage' },
  'storybook-static':{ category: 'output', tool: 'storybook' },

  // ── Rust / JVM ─────────────────────────────────────────────────────────────
  // `target` is Cargo's and Maven's build dir. Gated on a manifest so a directory
  // that merely happens to be called "target" is never touched.
  'target':          { category: 'output', tool: 'cargo/maven', requires: ['Cargo.toml', 'pom.xml'] },
  '.gradle':         { category: 'cache',  tool: 'gradle' },

  // ── .NET ───────────────────────────────────────────────────────────────────
  // `obj` only; `bin` is deliberately excluded — far too many repos keep real
  // scripts in bin/ for that to be safe.
  'obj':             { category: 'output', tool: 'dotnet', requires: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln'] },

  // ── Python ─────────────────────────────────────────────────────────────────
  '__pycache__':     { category: 'cache',  tool: 'python' },
  '.pytest_cache':   { category: 'cache',  tool: 'pytest' },
  '.mypy_cache':     { category: 'cache',  tool: 'mypy' },
  '.ruff_cache':     { category: 'cache',  tool: 'ruff' },
  '.tox':            { category: 'cache',  tool: 'tox' },

  // ── Dart / Flutter ─────────────────────────────────────────────────────────
  '.dart_tool':      { category: 'cache',  tool: 'dart', requires: ['pubspec.yaml'] },

  // ── Zig ────────────────────────────────────────────────────────────────────
  // zig-out is the install prefix, so it is output; both caches are pure cache.
  '.zig-cache':      { category: 'cache',  tool: 'zig', requires: ['build.zig'] },
  'zig-cache':       { category: 'cache',  tool: 'zig', requires: ['build.zig'] },
  'zig-out':         { category: 'output', tool: 'zig', requires: ['build.zig'] },

  // Bazel's bazel-out/bazel-bin/… are symlinks into its output base, so removing them frees
  // nothing and the scan (which only follows real directories) never sees them. The output
  // base itself is a shared store below.

  // ── Game engines ───────────────────────────────────────────────────────────
  // Unity's Library/ is regularly the single largest directory on a dev machine.
  // Both are gated on engine markers, since "Library" and "Intermediate" are common words.
  'Library':          { category: 'cache',  tool: 'unity',  requires: ['ProjectSettings', 'Assets'] },
  'Temp':             { category: 'cache',  tool: 'unity',  requires: ['ProjectSettings', 'Assets'] },
  'Intermediate':     { category: 'cache',  tool: 'unreal', requires: ['*.uproject'] },
  'DerivedDataCache': { category: 'cache',  tool: 'unreal', requires: ['*.uproject'] },
  'Binaries':         { category: 'output', tool: 'unreal', requires: ['*.uproject'] },
};

export const ARTIFACT_NAMES = Object.keys(ARTIFACTS);

/** Shared, machine-wide package-manager stores. Pruning is safe; re-download is the cost. */
export const STORES = [
  { name: 'pnpm store',   resolve: () => run('pnpm', ['store', 'path']).trim(), prune: ['pnpm', 'store', 'prune'], safe: true },
  { name: 'npm cache',    resolve: () => (IS_WIN && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_cacache') : path.join(paths.home, '.npm', '_cacache')),   prune: ['npm', 'cache', 'clean', '--force'], safe: true },
  { name: 'yarn cache',   resolve: () => run('yarn', ['cache', 'dir']).trim(),  prune: ['yarn', 'cache', 'clean'], safe: true },
  // Re-downloading browser binaries is expensive and often offline-hostile: never automatic.
  { name: 'go module cache', resolve: () => run('go', ['env', 'GOMODCACHE']).trim() || path.join(paths.home, 'go', 'pkg', 'mod'),
    prune: ['go', 'clean', '-modcache'], safe: true },
  { name: 'go build cache',  resolve: () => run('go', ['env', 'GOCACHE']).trim(), prune: ['go', 'clean', '-cache'], safe: true },
  { name: 'cargo registry',  resolve: () => path.join(paths.home, '.cargo', 'registry'), prune: null, safe: false,
    cost: 're-downloading every crate' },
  { name: 'nuget packages',  resolve: () => firstExisting([path.join(paths.home, '.nuget', 'packages')]),
    prune: ['dotnet', 'nuget', 'locals', 'global-packages', '--clear'], safe: true },
  { name: 'gradle caches',   resolve: () => path.join(paths.home, '.gradle', 'caches'), prune: null, safe: false,
    cost: 're-downloading every Gradle dependency' },
  { name: 'maven repository', resolve: () => path.join(paths.home, '.m2', 'repository'), prune: null, safe: false,
    cost: 're-downloading every Maven dependency, and losing anything installed locally' },
  { name: 'pip cache',       resolve: () => firstExisting([
      path.join(paths.xdgCache, 'pip'), path.join(paths.home, 'Library', 'Caches', 'pip')]),
    prune: ['pip', 'cache', 'purge'], safe: true },
  { name: 'playwright browsers', resolve: () => firstExisting([
      path.join(paths.home, 'Library', 'Caches', 'ms-playwright'),          // macOS
      path.join(paths.xdgCache, 'ms-playwright'),                          // Linux
      path.join(paths.home, 'AppData', 'Local', 'ms-playwright'),           // Windows
    ]), prune: null, safe: false, cost: 're-downloading browser binaries' },
  // Xcode rebuilds DerivedData on demand, but it is also where a running build writes, and
  // it has no prune command of its own: reported for its size, never deleted automatically.
  { name: 'xcode DerivedData', resolve: () => firstExisting([
      path.join(paths.home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
    ]), prune: null, safe: false, cost: 'a full rebuild of every Xcode project, and breaking any build running now' },
  { name: 'dart pub cache',  resolve: () => firstExisting([
      process.env.PUB_CACHE || '', path.join(paths.home, '.pub-cache'),
    ].filter(Boolean)), prune: null, safe: false, cost: 're-downloading every Dart and Flutter package' },
  { name: 'zig global cache', resolve: () => firstExisting([path.join(paths.xdgCache, 'zig'), path.join(paths.home, '.cache', 'zig')]),
    prune: null, safe: false, cost: 'recompiling the Zig standard library and every dependency' },
  // Bazel marks much of its output base read-only and tracks it per workspace: the way to
  // reclaim it is `bazel clean --expunge` inside each workspace, never an rm -rf from outside.
  { name: 'bazel output bases', resolve: () => firstExisting([
      path.join(paths.xdgCache, 'bazel'), path.join(paths.home, '.cache', 'bazel'),          // Linux
      `/private/var/tmp/_bazel_${userName()}`,                                     // macOS
    ]), prune: null, safe: false, rm: false, howTo: 'bazel clean --expunge in each workspace' },
  { name: 'puppeteer browsers',  resolve: () => firstExisting([
      path.join(paths.home, '.cache', 'puppeteer'),
      path.join(paths.xdgCache, 'puppeteer'),
    ]), prune: null, safe: false, cost: 're-downloading browser binaries' },
];

/** Store definitions by name: the plan and the renderer look up each store's cost and rules. */
export const STORE_BY_NAME = new Map(STORES.map((d) => [d.name, d]));

// ── processes ─────────────────────────────────────────────────────────────────

/** First match wins, so the specific patterns must precede the general ones. */
export const CLASSIFIERS = [
  { type: 'nx-daemon',    re: /\/nx\/(?:src|dist)\/daemon\/server\/start\.js/,     daemon: true },
  { type: 'nx-worker',    re: /\/nx\/(?:src|dist)\/project-graph\/plugins\// },
  { type: 'turbo-daemon', re: /\bturbod\b|\bturbo\b.*\bdaemon\b/,                  daemon: true },
  { type: 'tsserver',     re: /tsserver\.js|typescript\/lib\/tsserver/,            daemon: true },
  { type: 'watchman',     re: /\bwatchman\b/,                                      daemon: true },
  { type: 'metro',        re: /\bmetro\b/ },
  // nx ships its launcher at both nx/bin/nx.js and nx/dist/bin/nx.js depending on version;
  // matching only the first let `nx serve` fall through to the bare `node` catch-all.
  { type: 'nx-run',       re: /\/nx\/(dist\/)?bin\/nx\.js\s+\S/,                   work: true, reap: true },
  { type: 'esbuild',      re: /\/@esbuild\/[^/]+\/bin\/esbuild/,                   work: true, reap: true },
  { type: 'swc',          re: /\/@swc\/[^/]+\//,                                   work: true, reap: true },
  { type: 'typescript',   re: /\/typescript\/bin\/tsc\b|\btsc\b\s+--/,             work: true, reap: true },
  { type: 'test-runner',  re: /\b(jest|vitest|playwright|cypress|karma|mocha)\b/,  work: true, reap: true },
  { type: 'dev-server',   re: /\b(next|vite|webpack-dev-server|nodemon|ts-node-dev|storybook|wrangler|remix|astro)\b/, work: true, reap: true, server: true },
  { type: 'bundler',      re: /\b(webpack|rollup|parcel|tsup|rspack|turbo)\b/,     work: true, reap: true },
  { type: 'linter',       re: /\b(eslint|prettier|biome|stylelint)\b/,             work: true, reap: true },
  { type: 'pkg-manager',  re: /\b(pnpm|npm|yarn|npx|corepack)\b/ },
  { type: 'unity',        re: /Unity(\.app)?\/|UnityShaderCompiler|Unity Hub/,        work: true },
  { type: 'unreal',       re: /UnrealEditor|UE4Editor|UnrealBuildTool/,                work: true },
  // Only the build daemons are daemons. A bare `java -jar app.jar` is somebody's app — a
  // Spring Boot server, a Minecraft server — and classifying it as a daemon made tier 2
  // stop it whenever its project went quiet.
  { type: 'jvm',          re: /GradleDaemon|KotlinCompileDaemon|\bgradle\b/,           daemon: true },
  { type: 'java',         re: /\bjava\b/,                                              work: true },
  // Language servers are long-lived and hold gigabytes for hours: daemons, not work in
  // progress. Classifying them as work also made their project look active, which held
  // its artifacts out of tier 2 for as long as the editor stayed open. Ordered before the
  // go/rust/dotnet catch-alls, which would otherwise swallow them.
  { type: 'rust-analyzer', re: /\brust-analyzer\b/,                                     daemon: true },
  { type: 'gopls',         re: /\bgopls\b/,                                             daemon: true },
  { type: 'omnisharp',     re: /\bOmniSharp\b|Roslyn\S*LanguageServer/,                 daemon: true },
  { type: 'dotnet',       re: /\bdotnet\b|MSBuild/,                                     work: true },
  { type: 'go',           re: /\bgo (build|run|test|vet)\b|compile -o/,                work: true },
  { type: 'rust',         re: /\b(cargo|rustc)\b/,                                      work: true },
  { type: 'python',       re: /\b(python3?|pytest|uvicorn|gunicorn)\b/,                work: true },
  { type: 'claude',       re: /(^|\/)claude(\s|$)/ },
  // A compiled server — `node dist/apps/api/main.js` — is the most commonly forgotten
  // long-running process there is, and the bare `node` catch-all below never made it a
  // cleanup candidate. Only count an entrypoint inside a build directory, and never one
  // under node_modules, where this pattern would match half the toolchain.
  { type: 'node-server',  re: /^(?!.*node_modules).*\bnode\b.*[\s/](dist|build|out)\/\S*\.(c|m)?js\b/, work: true, reap: true, server: true },
  { type: 'node',         re: /\bnode\b/ },
];
export const BY_TYPE = Object.fromEntries(CLASSIFIERS.map((c) => [c.type, c]));
export const isDaemon = (t) => !!BY_TYPE[t]?.daemon;
// A server is something a person started and walked away from; a helper (esbuild, swc,
// tsc, a test worker) is spawned by whatever is running now. Age condemns a server on its
// own, but a helper is only ever garbage when its project has gone quiet too.
export const isServer = (p) => !!BY_TYPE[p.type]?.server || (p.type === 'nx-run' && /\bserve\b/.test(p.cmd));
export const isWork = (t) => !!BY_TYPE[t]?.work;
// What tier 2 may stop for being old: dev tooling that restarts in seconds. A Unity or
// Unreal editor, a `dotnet run`, a Jupyter server or a `cargo run` app can be up for days on
// purpose, and age says nothing about whether someone still needs it.
export const isReapable = (t) => !!BY_TYPE[t]?.reap;

export function classify(cmd) {
  for (const c of CLASSIFIERS) if (c.re.test(cmd)) return c.type;
  return 'other';
}
