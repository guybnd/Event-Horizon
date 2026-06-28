# EventHorizon — Agent Guide

EventHorizon ("Event Horizon" / FLUX) is a local-first, markdown-backed ticket board. The engine is an Express + TypeScript API (`engine/src/`); the portal is a React UI (`portal/src/`). Ticket workflow rules for agents live in [.claude/rules/event-horizon.md](.claude/rules/event-horizon.md) — that file governs how you interact with tickets (always via the `event-horizon` MCP tools, never by editing `.flux/` or `.flux-store/` directly).

## Validating changes — run `npm run check`

After editing code, run **`npm run check`** from the repo root before moving a ticket to `Ready`/`Done`. It is the type-check gate (portal + engine `tsc --noEmit`) and must exit 0 — neither runs as part of `dev` (the engine executes via `tsx`/esbuild, which strip types), so a type error surfaces nowhere else. The VS Code **Problems** panel is wired to the same checks via `.vscode/tasks.json` (run the default build task, "check"). Lint (`npm run lint -w portal`) and the engine test suite are **not** in the gate yet — their baselines are still being burned down (see the lint/test burndown tickets); run them directly when relevant.

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

`.mcp.json` spawns `serena` **per session over stdio** with `--project-from-cwd`, so each Claude Code session binds Serena to its **own** working directory:

```json
"serena": {
  "command": "serena",
  "args": ["start-mcp-server", "--context", "claude-code", "--project-from-cwd",
           "--open-web-dashboard", "False", "--enable-gui-log-window", "False"]
}
```

This per-session model is **required** for task **worktree** sessions to edit the right tree. A worktree runs from `<repoParent>/.eh-worktrees/<repo>-<id>`, but the committed `.serena/project.yml` carries `project_name: "EventHorizon"` and git worktrees share all tracked files — so every worktree would otherwise start Serena under the *same* name, and Serena's **name-keyed** project registry resolves `--project-from-cwd` back to the already-registered "EventHorizon" → the **main checkout**. Symbol edits then silently land on `master` in the main tree.

The engine fixes this when it creates a worktree (`engine/src/task-worktree.ts`, `createTaskWorktree`): it writes `<worktree>/.serena/project.local.yml` with a **unique** `project_name` (`<repo>-<id>`, e.g. `EventHorizon-FLUX-843`). `project.local.yml` is gitignored (`.serena/.gitignore`), so it is per-checkout and never shared into other worktrees. A name with no prior registration forces `--project-from-cwd` to register/bind at the **worktree path**, so Serena's edit tools write there — FLUX-843.

**Do not point worktree sessions at a shared HTTP Serena server.** A single shared server (e.g. one pinned with `--project <main-checkout>` on a fixed port) cannot auto-detect the project per client, so it binds every session to whatever path it was launched with — defeating per-worktree binding. If you run a shared server for convenience on the **main checkout only**, keep `.mcp.json` on the stdio per-session spawn above so worktrees stay correctly bound.

Either way the `serena` tools are scoped to this repo only — don't expect them to resolve symbols for other projects.
