# Contributing to chaff

## The one rule

chaff removes things from people's machines. Every change is judged first on whether it
can destroy work that a build cannot recreate. If a patch makes chaff faster, tidier or
more capable but widens that risk, it does not land.

## Ground rules for the codebase

- **No runtime dependencies.** chaff runs on a machine that is already under pressure, and
  it must work before `npm install` has ever succeeded. Node's standard library only.
- **Node >= 18**, ESM, no build step. `scripts/chaff.mjs` is the program; it is meant to be
  runnable straight from a checkout.
- **macOS and Linux both.** chaff shells out to `ps`, `du`, `df`, `find` and `git`, and BSD
  and GNU disagree about flags and output. CI runs both for this reason. If you touch a
  shell-out, you have to check both.
- **Never hard-fail a hook.** Hooks read the cached scan and exit 0 on every error path. A
  hook that blocks someone's session or denies their build because chaff had a bad day is a
  worse bug than whatever it was trying to prevent.

## Safety invariants

These are enforced by tests in `test/safety.test.mjs`. Do not weaken them:

- Tier 1 contains only things that no longer exist
- `applyPlan` never executes a `blocked` action, at any tier
- A dry run performs nothing at all
- Protected paths are excluded from every tier
- A live project is never killed
- Actions are sorted by tier, so `--tier=N` is a strict prefix

Removal goes through the trash — move, with a TTL and a tested `restore` — not `rm`. If you
are adding a new kind of cleanup, it goes through the trash too.

## Working on it

```
npm test                        # node --test, 50 tests, ~80s (it does real filesystem work)
node scripts/chaff.mjs scan --fresh
node scripts/chaff.mjs plan     # read-only, safe to run anywhere
node scripts/chaff.mjs doctor
```

Test against a repo chaff has never seen before you send anything. CI does this, but finding
it yourself is faster.

## Pull requests

- One concern per PR
- A new detector or cleanup rule needs a test showing what it does **and** a test showing
  what it refuses to touch
- Update `CHANGELOG.md` under `Unreleased`
- Explain the failure mode you are fixing, not just the code you changed

Comments in this codebase explain *why*, not *what*. Match that.

## Reporting bugs

Use the issue templates. For anything where chaff removed something it should not have, or
could be made to, use [Security](SECURITY.md) instead — privately.
