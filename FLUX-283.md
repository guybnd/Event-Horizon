---
id: FLUX-283
title: Extend session store to support multiple agent sessions
status: Todo
priority: High
effort: M
assignee: unassigned
tags:
  - feature
  - multi-agent
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Auto-created from inline subtask of FLUX-281.
  - type: activity
    user: Agent
    date: '2026-05-25T11:45:02.387Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Updated ticket body with research findings from FLUX-282. Added: session
      lifecycle details per CLI (resume, background, listing), orchestration
      primitive specs (relay/scatter-gather/supervisor), conflict prevention via
      tool gating, and MCP bus coordination pattern. Implementation plan now has
      concrete steps informed by actual CLI capabilities.
    date: '2026-05-25T11:45:15.432Z'
    id: c-2026-05-25t11-45-15-432z
---

Subtask of FLUX-281.

## Problem / Motivation

The current session store enforces a 1-to-1 mapping (one CLI session per ticket). The multi-agent architecture requires 1-to-many sessions per ticket, each tagged with a role and orchestration pattern position. Research (FLUX-282) confirmed the CLI capabilities that inform this design.

## Research Findings Informing This Ticket

**Session lifecycle per CLI:**
- Claude: `--resume <session_id>` continues paused sessions; `--bg` runs background sessions; `claude agents --json` lists active sessions
- Copilot: `--session-id` / `--resume` for continuation; `--share ./state.md` persists session output
- Gemini: No documented headless session resume — treat as fire-and-forget

**Orchestration primitives to implement:**
1. **Relay (Sequential):** Output of Agent A piped as `--append-system-prompt` or stdin to Agent B via `--output-format json`
2. **Scatter-Gather (Parallel):** Multiple `--bg` sessions (Claude) or parallel spawns; barrier waits for all to complete before synthesis agent launches
3. **Supervisor (Dynamic):** Lead session uses MCP bus tools (`publish_result`, `wait_for_input`, `get_task_status`) to coordinate child agents on-demand

**Conflict prevention mechanisms:**
- Claude: `--allowedTools` restricts write access per session (e.g., reviewer gets `"Read,Glob,Grep"` only)
- Copilot: `--allow-tool` / `--deny-tool` granular per invocation
- Gemini: `tools:` array in agent YAML definition

**MCP bus pattern for shared state:**
A custom MCP server acts as message queue between agents. All CLIs support MCP config (`--mcp-config` / `.mcp.json` / `.gemini/settings.json`). The bus provides coordination tools without direct inter-process communication.

## Implementation Plan

1. Refactor `session-store.ts` from `cliSessionIdByTaskId: Map<string, string>` to `cliSessionsByTaskId: Map<string, AgentSession[]>` where each session has: `id`, `role`, `cliType`, `patternPosition`, `status`, `lockedPaths[]`
2. Add orchestration state tracking: pattern type (relay/scatter-gather/supervisor), step index, barrier status
3. Implement file-locking: sessions declare write-intent paths at launch; engine rejects conflicting launches with 409
4. Update `routes/cli-session.ts`: remove single-session 409 guard, add `GET /:id/cli-sessions` (list all), `POST` with `role` + `pattern` params
5. Add session output storage for chaining: when a session completes in relay mode, its JSON output is stored for the next step's prompt injection
6. Implement barrier primitive for scatter-gather: track completion of parallel group, trigger synthesis session when all resolve
