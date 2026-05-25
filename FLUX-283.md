---
id: FLUX-283
title: Extend session store to support multiple agent sessions
status: In Progress
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
  - type: activity
    user: Agent
    date: '2026-05-25T11:49:12.413Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T14:45:19.756Z'
  - type: comment
    user: Agent
    comment: >-
      Implementation plan: (1) Add AgentSession interface and CLI capabilities
      registry to types.ts, (2) Refactor session-store.ts from single-session
      Map to multi-session Map with file-lock and orchestration tracking, (3)
      Update routes/cli-session.ts to support multiple sessions per task with
      new GET list endpoint, (4) Maintain backwards compat in
      getCliSessionSummaryForTask by returning the most recent active session
      for existing single-session consumers.
    date: '2026-05-25T14:45:33.298Z'
    id: c-2026-05-25t14-45-33-298z
---

Subtask of FLUX-281.

## Problem / Motivation

The current session store enforces a 1-to-1 mapping (one CLI session per ticket). The multi-agent architecture requires 1-to-many sessions per ticket, each tagged with a role and orchestration pattern position. Research (FLUX-282) confirmed the CLI capabilities that inform this design.

**Design principle: Claude-first.** Claude Code is the default and most common integration — richest orchestration primitives (subagents, background sessions, session resume, tool gating, structured output). Gemini and Copilot are supported alternatives but the happy path optimizes for Claude.

## Research Findings Informing This Ticket

**Claude Code (primary path):**
- `--resume <session_id>` continues paused sessions — enables Supervisor and Relay patterns natively
- `--bg` runs background sessions; `claude agents --json` lists active — enables Scatter-Gather
- `--allowedTools` enforces role boundaries at CLI level
- `--output-format json` provides structured output for chaining
- `--append-system-prompt` / `--append-system-prompt-file` injects role identity per invocation
- Session resume + MCP bus = full event-driven coordination

**Gemini CLI (supported, with constraints):**
- No documented headless session resume — treat as fire-and-forget
- Cannot participate as Supervisor lead (can't spawn children and wait)
- Leaf-node executor only in complex patterns
- `tools:` array in agent YAML for tool gating
- Has `max_turns` / `timeout_mins` constraints (useful for bounding execution)

**Copilot CLI (supported, with constraints):**
- `--session-id` / `--resume` for continuation — similar to Claude
- `--allow-tool` / `--deny-tool` for granular gating
- BYOK mode can use Claude/Gemini models via `COPILOT_PROVIDER_BASE_URL`
- `--mode autopilot` + `--max-autopilot-continues` for bounded autonomous execution

**Universal coordination layer — MCP bus:**
All three CLIs support MCP config. A custom MCP server acting as message queue is the only coordination mechanism that works identically across all CLIs. Should be primary inter-agent communication path, not a fallback.

## Implementation Plan

1. Refactor `session-store.ts` from `cliSessionIdByTaskId: Map<string, string>` to `cliSessionsByTaskId: Map<string, AgentSession[]>` where each session has: `id`, `role`, `cliType`, `patternPosition`, `status`, `lockedPaths[]`
2. Add `cliCapabilities` registry defining what each CLI supports:
   ```ts
   { claude: { resume: true, background: true, supervisor: true, scatter: true },
     gemini: { resume: false, background: false, supervisor: false, scatter: true },
     copilot: { resume: true, background: false, supervisor: false, scatter: true } }
   ```
3. Add orchestration state tracking: pattern type (relay/scatter-gather/supervisor), step index, barrier status
4. Implement file-locking: sessions declare write-intent paths at launch; engine rejects conflicting launches with 409
5. Update `routes/cli-session.ts`: remove single-session 409 guard, add `GET /:id/cli-sessions` (list all), `POST` with `role` + `pattern` params. Default `cliType` to `claude` when unspecified.
6. Session output storage for chaining: when a session completes in relay mode, capture its JSON output for the next step's prompt injection
7. Barrier primitive for scatter-gather: track completion of parallel group, trigger synthesis session when all resolve
8. Validate orchestration requests against `cliCapabilities` — reject invalid combos (e.g., Gemini as Supervisor) at launch time with a descriptive error
