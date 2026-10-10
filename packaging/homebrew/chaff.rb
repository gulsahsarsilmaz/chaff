# Homebrew formula for chaff.
#
# This file does not live here in the end — Homebrew reads formulae from a tap repo. Copy it
# to `Formula/chaff.rb` in `gulsahsarsilmaz/homebrew-chaff` and users get:
#
#     brew tap gulsahsarsilmaz/chaff
#     brew install chaff
#
# The url and sha256 below are filled in per release. The release workflow prints both in the
# GitHub release notes after publishing to npm — paste them in and commit to the tap.
class Chaff < Formula
  desc "Separate live work from dead weight on a developer machine, with tiered safe cleanup"
  homepage "https://github.com/gulsahsarsilmaz/chaff"
  url "https://registry.npmjs.org/@gulsahsarsilmaz/chaff/-/chaff-0.3.1.tgz"
  sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_NOTES"
  license "MIT"

  # chaff is dependency-free JavaScript; it needs a Node runtime and nothing else.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # `help` needs no filesystem scan, so it is the one command guaranteed to work in a
    # sandbox with no repos, no home directory state and no network.
    assert_match "chaff", shell_output("#{bin}/chaff help")

    # A scan must survive a directory that contains nothing chaff recognises.
    system bin/"chaff", "plan", "--json"
  end
end
