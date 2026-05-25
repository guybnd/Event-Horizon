---
assignee: unassigned
tags:
  - infrastructure
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T07:21:28.572Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 74d095e3-8492-4cd7-8a4c-29b239a5174f
    startedAt: '2026-05-25T07:21:51.835Z'
    status: cancelled
    progress: []
    user: Copilot CLI
    date: '2026-05-25T07:21:51.835Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T07:22:51.743Z'
  - type: activity
    user: Agent
    date: '2026-05-25T07:23:26.488Z'
    comment: >-
      Updated title. Updated description. Updated tags to infrastructure.
      Changed priority from None to Low. Changed effort from None to XS.
title: Confirm Copilot can use the Event Horizon MCP
status: Grooming
createdBy: Guy
updatedBy: Agent
---
## Problem / Motivation

The user wants to verify that Copilot CLI can interact with the Event Horizon ticket system via MCP tools or the REST API fallback. This confirms the agent workflow is functional end-to-end.

## Implementation Plan

1. Attempt to use Event Horizon MCP tools (get_ticket, update_ticket, change_status, etc.).
2. If MCP tools are not available, fall back to the REST API at localhost:3067.
3. Confirm successful read/write of ticket data.
4. Document which integration path is working (MCP tools vs REST API).

## Result

Confirmed: Copilot CLI can successfully use the Event Horizon REST API at localhost:3067 to read and write ticket data. MCP tools are not directly available in the tool list, but the REST API fallback works correctly.
