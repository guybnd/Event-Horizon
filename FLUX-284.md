---
id: FLUX-284
title: Live agent session panel — runtime status & controls
status: Todo
priority: High
effort: S
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
    date: '2026-05-25T11:45:03.591Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Updated ticket body with research findings from FLUX-282. Added: CLI
      capabilities the UI must expose (mode selection, model override,
      background), orchestration pattern visualizations needed
      (relay/scatter-gather/supervisor), session states to display, and
      per-session metadata from JSON output. Implementation plan now covers
      pipeline builder, active agents panel, and templates.
    date: '2026-05-25T11:45:16.693Z'
    id: c-2026-05-25t11-45-16-693z
  - type: activity
    user: Agent
    date: '2026-05-25T11:49:13.403Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-25T11:53:49.654Z'
    comment: Updated title. Updated description. Changed effort to S.
---

Subtask of FLUX-281.

## Problem / Motivation

When multi-agent sessions are running against a ticket, the user needs real-time visibility into what's happening: which agents are active, their status, token usage, and controls to stop/re-run/inspect. This is the **runtime** counterpart to FLUX-312 (design-time workflow configuration).

**Scope clarification:** FLUX-312 handles workflow template building (choosing which agents run in what pattern). This ticket handles the live execution panel that appears once a workflow is launched.

**Design principle: Claude-first.** Claude sessions show the richest state (pending/running/waiting/completed/failed). Gemini sessions show a reduced set (no "waiting" — it can't resume). Copilot similar to Claude.

## Implementation Plan

1. Active agents panel component (`ActiveAgentsPanel.tsx`) — shown per ticket when sessions exist
2. Session card per running/completed agent:
   - Role label, CLI type icon, status badge, elapsed time, token count
   - Controls: stop (kill process), re-run (relaunch same config), inspect output (expand JSON result)
   - Attach/resume button — only shown for Claude/Copilot sessions (capability-gated)
3. Pipeline progress indicator — shows which step in the workflow is currently active (relay arrow, scatter fan-out visual, supervisor tree)
4. Auto-refresh via polling or SSE from session store API (`GET /api/tasks/:id/cli-sessions`)
5. Gemini sessions: hide "waiting" status and "attach" control (not supported per FLUX-282 research)

### Dependencies

- FLUX-283 (session store API provides the data)
- FLUX-312 (workflow config determines what launched — but this ticket is independent of the builder UI)
