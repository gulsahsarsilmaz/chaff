<!--
Thanks for contributing to chaff! First time here? CONTRIBUTING.md has the two-minute version
of how the code is laid out and what a good change looks like. Small PRs are very welcome.
-->

## What does this change?

<!-- The behaviour that was wrong or missing, not just the code that changed. Link the issue if there is one: "Fixes #123". -->

## How did you test it?

<!-- Commands you ran, what you saw. A before/after `chaff plan` line is perfect for detector changes. -->

## Safety checklist

chaff deletes things on other people's machines, so every change answers these:

- [ ] Nothing it can remove is something a build cannot recreate
- [ ] New removals go through the trash (move + TTL + `chaff restore`), not `rm`
- [ ] If this adds a detector or cleanup rule: a test for what it **does** touch, and a test for what it **refuses** to touch
- [ ] The safety invariants in `test/safety.test.mjs` still hold

## Housekeeping

- [ ] `npm test` passes
- [ ] Tested on macOS and Linux, or the change touches no shell-out (`ps`, `du`, `find`, `git`, …)
- [ ] `CHANGELOG.md` updated, if users would notice the change
