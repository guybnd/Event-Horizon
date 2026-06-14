# EventHorizon — Agent Guide

EventHorizon ("Event Horizon" / FLUX) is a local-first, markdown-backed ticket board. The engine is an Express + TypeScript API (`engine/src/`); the portal is a React UI (`portal/src/`). Ticket workflow rules for agents live in [.claude/rules/event-horizon.md](.claude/rules/event-horizon.md) — that file governs how you interact with tickets (always via the `event-horizon` MCP tools, never by editing `.flux/` or `.flux-store/` directly).

## Code Navigation — Use Serena's Symbol Tools

This is a TypeScript codebase indexed by **Serena** (MCP server `serena`, available via `ToolSearch` with query `serena`). Serena gives you language-server-backed semantic navigation that is faster and more precise than text search for code. **Prefer it over raw `Grep`/`Glob` whenever you are working with code symbols.**

- **First time you touch code in a session**, call `mcp__serena__initial_instructions` once to load Serena's usage manual, then use its tools.
- **Use Serena for:**
  - `get_symbols_overview` — see the top-level symbols of a file before reading it whole.
  - `find_symbol` — jump to a function/class/method by name path instead of grepping.
  - `find_referencing_symbols` — find all call sites / usages before changing a signature.
  - `replace_symbol_body` / `insert_after_symbol` / `insert_before_symbol` — edit a symbol precisely without re-reading the whole file.
  - `rename_symbol` — rename across the codebase via the language server, not find-and-replace.
- **Still use built-in `Grep`/`Read`** for non-code text (markdown, configs, logs), for string-literal searches, and when you already know the exact file and line.

### Serena transport (local dev)

`.mcp.json` points `serena` at a **shared streamable-http server** (`http://127.0.0.1:9122/mcp`, pinned to this project). The intent: when several Claude Code sessions are open on this repo, they all reuse **one** language-server process instead of each stdio-spawning its own Serena + tsserver stack (which otherwise multiplies memory and process count, and adds a dashboard/tray per instance).

You are responsible for having that server running locally — it is not started by the repo. Start it with:

```
serena start-mcp-server --context claude-code --project <path-to-this-repo> \
  --transport streamable-http --port 9122 \
  --enable-web-dashboard False --enable-gui-log-window False
```

(On a dev machine you'd typically wire this into a logon task so it's always up.) If you don't want to run a shared server, swap the `serena` entry in `.mcp.json` for a per-session stdio spawn instead:

```json
"serena": {
  "command": "serena",
  "args": ["start-mcp-server", "--context", "claude-code", "--project-from-cwd",
           "--open-web-dashboard", "False", "--enable-gui-log-window", "False"]
}
```

Either way the `serena` tools are scoped to this repo only — don't expect them to resolve symbols for other projects.
