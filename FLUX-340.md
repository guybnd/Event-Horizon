---
id: FLUX-340
title: 'Portal UI — branch display in card, modal, and metadata panel'
status: Todo
priority: Medium
effort: M
assignee: unassigned
tags:
  - feature
  - portal
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:44.306Z'
    comment: Created as subtask of FLUX-292.
---
## Problem / Motivation

Users need visibility into which branch is associated with a ticket, directly from the board and ticket views.

## Implementation Plan

1. **TaskCard.tsx**: Show a small branch badge (git-branch icon + truncated branch name) below title when `task.branch` is set. Click copies name to clipboard.

2. **MetadataPanel.tsx**: Add a "Branch" field row. Show "Create Branch" button when no branch is set and ticket is in a workable status (Todo/In Progress). Show branch status indicators (exists/deleted, ahead/behind main) via the GET endpoint.

3. **TaskModal.tsx**: Display branch name in header area next to implementation link. Add copy-to-clipboard action.

4. Use the `GET /api/tasks/:id/branch` endpoint to fetch live branch status (exists, ahead/behind counts).
