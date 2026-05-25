---
id: FLUX-294
title: Verify MCP tools work correctly from agent sessions
status: Todo
priority: Low
effort: XS
assignee: unassigned
tags:
  - infra
  - mcp
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-25T05:24:17.926Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    comment: >-
      Groomed and moved to Todo. This is an XS validation ticket — the ticket's
      own lifecycle serves as the test of MCP tool correctness. Tools verified
      so far: create_ticket ✓, get_ticket ✓, list_tickets ✓, update_ticket ✓
      (initial call succeeded before engine restart lost the file). Remaining
      tools to verify during implementation: change_status, add_comment,
      log_progress, finish_ticket.
    id: c-1779686667380-2
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
