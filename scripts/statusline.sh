#!/bin/sh
# Composable statusline fragment. Reads the cached scan only — never scans inline, so it
# stays instant no matter how large the tree is.
#   "statusLine": { "type": "command", "command": "sh /path/to/chaff/scripts/statusline.sh" }
exec node "$(dirname "$0")/chaff.mjs" statusline 2>/dev/null
