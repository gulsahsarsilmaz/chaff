# Ambient chaff, in any terminal

The Claude Code plugin puts chaff in the statusline. Nothing else can do that: MCP is
request/response and has no way to render anything persistently, so Codex, Cursor and Zed
will only ever show chaff when the model calls a tool.

The surface that is always visible regardless of which agent you are running is the terminal
itself. `chaff statusline` exists for this — it reads the cached scan and never scans inline,
so it costs one Node startup (~40ms) and nothing else.

## tmux — the best fit

Always visible, refreshes on a timer, costs nothing between refreshes.

```tmux
# ~/.tmux.conf
set -g status-interval 15
set -g status-right '#(chaff statusline --stale=300 --plain) | %H:%M'
set -g status-right-length 120
```

## Starship — every prompt, any shell

```toml
# ~/.config/starship.toml
[custom.chaff]
command = "chaff statusline --stale=300 --plain"
when = true
format = "[$output]($style) "
style = "dimmed white"
shell = ["sh", "-c"]
```

Starship runs custom modules with a timeout; if 40ms ever becomes noticeable, raise
`command_timeout` rather than dropping the module.

## zsh

```zsh
# ~/.zshrc — right-hand prompt, so it never pushes your command around
chaff_rprompt() { RPROMPT="$(chaff statusline --stale=300 --plain 2>/dev/null)" }
autoload -Uz add-zsh-hook && add-zsh-hook precmd chaff_rprompt
```

`chaff statusline` always exits 0 and always prints a line, so it will sit in your prompt
whether or not anything is wrong. If you only want it when the machine is actually under
pressure, filter on the marker chaff uses for a breach:

```zsh
# `dots` style marks breached metrics with an emoji; no emoji means nothing is wrong.
chaff_rprompt() {
  local out; out="$(chaff statusline --stale=300 --plain 2>/dev/null)"
  case "$out" in (*[!\ -~]*) RPROMPT="$out" ;; (*) RPROMPT="" ;; esac
}
```

## bash

```bash
# ~/.bashrc
PROMPT_COMMAND='__chaff=$(chaff statusline --stale=300 --plain 2>/dev/null)'
PS1='${__chaff:+$__chaff\n}\u@\h:\w\$ '
```

## fish

```fish
# ~/.config/fish/config.fish
function fish_right_prompt
    chaff statusline --stale=300 --plain 2>/dev/null
end
```

## A note on cost

All of these read `~/.chaff/scan-cache.json`. When the cache is older than `--stale`, chaff
kicks off a **detached** refresh and still prints the stale value immediately — your prompt is
never blocked on a filesystem walk. This is the same discipline the SessionStart hook uses.
