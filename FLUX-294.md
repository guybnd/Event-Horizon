---
assignee: unassigned
tags:
  - infra
  - mcp
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T05:22:55.298Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 53b7502c-e1f7-4ab0-8aa9-c1bcc43a4170
    startedAt: '2026-05-25T05:23:01.803Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T05:23:01.803Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T05:23:10.998Z'
  - type: activity
    user: Agent
    date: '2026-05-25T05:23:39.882Z'
    comment: >-
      Updated description. Changed priority to Low. Changed effort to XS.
      Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Groomed: XS effort validation task. The ticket itself serves as the test —
      exercising MCP tools through its own lifecycle confirms they work. Moving
      to Todo.
    id: c-1779686625562-4
id: FLUX-294
title: check you are able to properly use the new MCP from the ticket here
status: Grooming
createdBy: Guy
updatedBy: Agent
---
## Problem / Motivation

The Event Horizon MCP server was recently added. We need to verify that all MCP tools (`get_ticket`, `list_tickets`, `get_board_config`, `create_ticket`, `create_subtask`, `update_ticket`, `change_status`, `add_comment`, `log_progress`, `finish_ticket`) work correctly when invoked by an agent during a ticket workflow.

## Implementation Plan

1. Exercise each MCP tool in sequence during this ticket's own lifecycle (grooming → todo → in progress → done).
2. Confirm that `get_ticket` returns full frontmatter, body, and history.
3. Confirm that `update_ticket` persists metadata and body changes.
4. Confirm that `change_status` transitions work and enforce comment requirements.
5. Confirm that `add_comment` and `log_progress` append to history.
6. Confirm that `finish_ticket` atomically sets implementationLink and moves to Done.
7. If any tool fails or behaves unexpectedly, document the issue as a new ticket.
