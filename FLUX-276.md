---
title: 'API: subtask creation endpoint for agents and portal'
status: Grooming
priority: Medium
effort: S
assignee: unassigned
tags:
  - engine
  - feature
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-19T07:39:00.000Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 4c5fd862-ea88-4a2a-9e7d-66d660715402
    startedAt: '2026-05-25T04:39:51.938Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T04:39:51.938Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T04:44:44.763Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T04:40:50.292Z'
  - type: comment
    user: Agent
    comment: >-
      Starting implementation. The POST /api/tasks/:parentId/subtasks endpoint
      already exists. Will add --add-subtask CLI flag to patch-ticket.ts and
      update skill documentation.
    date: '2026-05-25T04:40:50.292Z'
    id: c-2026-05-25t04-40-50-292z
  - type: activity
    user: Agent
    date: '2026-05-25T04:42:47.541Z'
    comment: Updated subtasks.
  - type: activity
    user: Agent
    date: '2026-05-25T04:43:14.278Z'
    comment: Updated subtasks.
  - type: agent_session
    sessionId: 1bdbd2ff-8fe5-433d-bc3f-a079c8633820
    startedAt: '2026-05-25T04:45:26.563Z'
    status: cancelled
    progress: []
    user: Copilot CLI
    date: '2026-05-25T04:45:26.563Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T04:47:00.090Z'
  - type: status_change
    from: In Progress
    to: Grooming
    user: Guy
    date: '2026-05-25T07:25:15.451Z'
  - type: comment
    user: Guy
    date: '2026-05-25T07:25:26.768Z'
    comment: regroom this after all out changes with mCP etc
    id: c-2026-05-25t07-25-26-764z
  - type: agent_session
    sessionId: bd2016d6-9d43-4615-b485-6f064924aa7e
    startedAt: '2026-05-25T07:25:28.250Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T07:25:28.250Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T07:25:36.152Z'
subtasks: []
order: 13
implementationLink: ''
id: FLUX-276
---

## Problem

Agents have no structured way to create subtasks. They either manually edit YAML (error-prone, leads to inline objects) or don't create subtasks at all. The portal UI also lacks a "Create subtask" flow that atomically creates a child ticket and links it.

## Solution

Add a `POST /api/tasks/:parentId/subtasks` endpoint that:

1. Accepts `{ title, status?, priority?, effort?, body? }`.
2. Generates the next available ticket ID.
3. Creates the `.flux/<newId>.md` file with proper frontmatter.
4. Appends the new ID to the parent ticket's `subtasks` array.
5. Returns the created task.

Also add a corresponding `patch-ticket` CLI flag: `--add-subtask <parentId>` so agents can use the CLI to create subtasks atomically.

Update skill files to instruct agents to use this endpoint/CLI for subtask creation.

## Acceptance Criteria

- [ ] `POST /api/tasks/:parentId/subtasks` creates a child ticket and links it.
- [ ] New ticket gets the next sequential ID.
- [ ] Parent's `subtasks` array is updated atomically on disk.
- [ ] Skill files reference the endpoint/CLI for subtask creation.
- [ ] Portal UI can call this endpoint (future: "Create subtask" button).
