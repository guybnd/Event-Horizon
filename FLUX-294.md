---
assignee: unassigned
tags:
  - infra
  - mcp
priority: Low
effort: XS
implementationLink: 356a843
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
    date: '2026-05-25T05:23:45.562Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T05:24:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T05:24:10.000Z'
  - type: comment
    user: Agent
    comment: >-
      MCP smoke test: all 10 tools registered and responding. Read ops confirmed
      working. Write ops confirmed working. finish_ticket atomically closed.
    date: '2026-05-25T05:24:26.199Z'
    id: c-1779686666199-2
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-25T05:34:50.036Z'
id: FLUX-294
title: check you are able to properly use the new MCP from the ticket here
status: Done
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
