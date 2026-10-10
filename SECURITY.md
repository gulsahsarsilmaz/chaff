# Security Policy

chaff deletes files, moves directories and signals processes. A bug in it costs people
work. Security reports are treated accordingly.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/gulsahsarsilmaz/chaff/security/advisories)
2. Click **Report a vulnerability**

You will get an acknowledgement within 72 hours and a fix or an explanation within 14 days.
If a fix ships, you are credited in the advisory and the CHANGELOG unless you ask otherwise.

## What counts as a vulnerability

chaff's safety model is that it only ever removes things that are regenerable, and that it
moves rather than destroys. Anything that breaks that model is in scope:

- **Protected-path bypass** — a way to get chaff to act on a path in the `protect` list
- **Path traversal** — a crafted project name, worktree path or config value that escapes
  the configured roots
- **Tier violation** — an action appearing in a tier below the one it belongs to, or a
  `blocked` action executing at any tier
- **Destroying non-regenerable data** — anything removed that a build cannot recreate:
  source, uncommitted work, credentials, databases, `.env` files
- **Killing live work** — a process with an active parent, or a worktree with uncommitted
  changes, being reaped
- **Dry-run violation** — `--dry-run` or `plan` mutating anything at all
- **Privilege or injection** — shell injection via a filename, repo name or config value

## What does not count

- chaff removing something regenerable that you wanted to keep, where it was correctly
  classified and you ran the tier anyway. Use the `protect` list, and `chaff restore`.
- Disk exhaustion caused by chaff's own trash directory. It has a TTL; tune it.
- Anything requiring an attacker to already have write access to your `~/.chaff/config.json`
  or your shell. At that point they do not need chaff.

## Supported versions

The latest minor release receives security fixes. chaff is pre-1.0; older minors are not
backported.
