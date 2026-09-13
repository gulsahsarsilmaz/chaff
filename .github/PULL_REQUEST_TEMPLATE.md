## What failure does this fix?

<!-- The behaviour that was wrong, not just the code that changed. -->

## Safety

- [ ] Nothing removed here is anything a build cannot recreate
- [ ] New removals go through the trash (move + TTL + `restore`), not `rm`
- [ ] Safety invariants in `test/safety.test.mjs` still hold
- [ ] If this adds a detector or cleanup rule: there is a test for what it **does**, and a
      test for what it **refuses to touch**

## Checks

- [ ] `npm test` passes
- [ ] Tested on macOS and Linux, or the change touches no shell-out
- [ ] `CHANGELOG.md` updated under `Unreleased`
