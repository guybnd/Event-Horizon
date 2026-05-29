---
id: FLUX-339
title: Agent workflow skill integration for branch management
status: Todo
priority: Medium
effort: S
assignee: unassigned
tags:
  - feature
  - agent-workflow
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:44.088Z'
    comment: Created as subtask of FLUX-292.
---
## Problem / Motivation

The agent implementation skill needs updated instructions so agents automatically create and use feature branches during ticket work.

## Implementation Plan

1. Update `.claude/rules/event-horizon.md` implementation skill:
   - Step 4 (move to In Progress): add instruction to call `create_branch` if `get_branch` returns no branch.
   - Commits go to the ticket branch, not master.
   - On `finish <ticket>`: branch info preserved in ticket for reference; no auto-merge.

2. Update the orchestrator skill's MCP tool table to include `create_branch`, `switch_branch`, `get_branch`, `delete_branch`.

3. Add a note that branch creation is optional for XS effort tickets (not worth the overhead).
