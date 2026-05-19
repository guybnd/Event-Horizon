---
id: FLUX-276
title: "API: subtask creation endpoint for agents and portal"
status: Todo
priority: Medium
effort: S
assignee: unassigned
tags:
  - engine
  - feature
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-19T07:39:00.000Z'
    comment: Created ticket.
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
