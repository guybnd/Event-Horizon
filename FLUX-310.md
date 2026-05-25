---
title: >-
  Copilot CLI MCP tools not loading when spawned by engine (node entrypoint
  bypass)
status: Done
priority: High
effort: M
assignee: unassigned
tags:
  - bug
  - mcp
  - copilot-cli
  - agent-integration
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-25T07:50:51.255Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 26c1909b-51e8-4358-82d5-0571fee446f7
    startedAt: '2026-05-25T09:54:13.598Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T09:54:13.598Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T09:54:21.740Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T09:54:48.093Z'
  - type: comment
    user: Agent
    comment: >-
      Implementation plan: Restructure resolveCopilotBinary() to prefer
      copilot.exe over the node + npm-loader.js path on Windows. The JS entry
      point bypasses MCP server initialization that the compiled binary handles.
      Will reorder the resolution logic so .exe is tried first, with
      node+entrypoint as fallback only.
    date: '2026-05-25T09:54:48.957Z'
    id: c-2026-05-25t09-54-48-957z
  - type: comment
    user: Agent
    comment: >-
      Fix committed (d5b741b). Reordered resolveCopilotBinary() to prefer
      copilot.exe over node+entrypoint. The compiled binary handles MCP
      initialization; the JS entry point skips it. Now .exe is tried first via
      `where copilot`, then VS Code globalStorage, with node+JS as last-resort
      fallback only.
    date: '2026-05-25T11:23:43.736Z'
    id: c-2026-05-25t11-23-43-736z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T11:23:43.738Z'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-25T11:24:31.480Z'
order: 1
---
## Problem / Motivation

When the Event Horizon engine spawns a Copilot CLI session for a ticket (e.g. FLUX-309), the agent reports **"I don't have Event Horizon MCP tools in my tool list"** and falls back to the REST API. Meanwhile, Claude CLI and Gemini CLI sessions successfully load and use the MCP tools.

This was observed on FLUX-309 (session `74d095e3-8492-4cd7-8a4c-29b239a5174f`, 2026-05-25T07:21:51Z) — even after both the config path fix (`65043fe`) and the prompt instruction fix (`a97fae2`) were in place.

## Evidence

- **Interactive Copilot CLI** (user-launched `copilot` in terminal): MCP tools load correctly — all 10 `event-horizon-*` tools appear in tool list.
- **Engine-spawned Copilot CLI** (`-p "..." --output-format json`): MCP tools NOT available — agent falls back to REST API at localhost:3067.
- **Claude CLI / Gemini CLI** (engine-spawned): MCP tools load fine.

## Root Cause Hypothesis

The engine's `spawnCopilot()` function in `engine/src/agents/copilot.ts` uses a Windows-specific workaround:

```typescript
// On Windows, prefer spawning node + JS entry point
spawn(nodePath, [entryPoint, ...args], {
  cwd: workspaceRoot,
  env: cleanChildEnv(),
  stdio: 'pipe',
  windowsHide: true,
});
```

When it finds the Copilot CLI's JS entry point via npm global prefix, it spawns `node <entrypoint.js> -p "..." --output-format json` instead of running the `copilot.exe` binary directly.

**This `node + JS entrypoint` path may bypass the MCP server initialization logic** that the compiled binary performs. The standalone `copilot.exe` (or the interactive `copilot` command) handles `.mcp.json` reading and MCP server spawning as part of its startup, but the raw Node.js entry point may skip or fail this step.

Claude and Gemini don't have this issue because their spawn code uses `.exe` directly (they resolve the compiled binary, not a JS entry point).

## Investigation Steps

1. **Check engine logs** from the FLUX-309 session — confirm whether `node + entryPoint` or `copilot.exe` path was used.
2. **Test both spawn paths** manually:
   - `copilot.exe -p "list your MCP tools" --output-format json` → does it show MCP tools?
   - `node <copilot-entry.js> -p "list your MCP tools" --output-format json` → does it show MCP tools?
3. **Check MCP startup timeout** — the Event Horizon MCP server takes 5-8s to load 250+ tickets. Does the Copilot CLI have an internal timeout for MCP initialization in `-p` mode?
4. **Compare with Claude/Gemini** — both use compiled binary paths on Windows, not `node + entry.js`.

## Possible Fixes

1. **Prefer `copilot.exe` over `node + entrypoint`** in `resolveCopilotBinary()` — skip the JS entry point path for Copilot and always use the binary (like Claude/Gemini do).
2. **Add `--mcp-timeout` flag** (if supported) when spawning Copilot to allow more startup time.
3. **Lazy-load workspace in MCP server** — connect transport immediately, return "activating" errors on early tool calls. This reduces the window where a timeout could occur.
4. **Add explicit `--mcp-config` flag** pointing to `.mcp.json` when spawning (if Copilot supports it).

## Related

- FLUX-309 — Original ticket where this was observed
- Commit `65043fe` — Fixed `.mcp.json` config path and added `"type": "stdio"`
- Commit `a97fae2` — Fixed prompts to instruct MCP tool usage
- `engine/src/agents/copilot.ts` — Spawn logic (lines 333-465)
- `.mcp.json` — MCP server configuration
