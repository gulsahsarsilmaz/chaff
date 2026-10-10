# Homebrew packaging

`chaff.rb` is the formula. It is kept here so it is versioned alongside the code, but
Homebrew will not read it from this path.

## One-time tap setup

1. Create a public repo `lockdownmedia/homebrew-chaff`
2. `mkdir Formula && cp chaff.rb Formula/chaff.rb`
3. Commit and push

The tap name comes from the repo name: `homebrew-chaff` is installed as
`brew tap lockdownmedia/chaff`.

## Each release

The release workflow publishes to npm, then prints the tarball URL and its sha256 in the
GitHub release notes. Update those two lines in `Formula/chaff.rb` in the tap repo and
commit. `brew audit --strict --new chaff` before pushing the first one.
