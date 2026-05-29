---
id: FLUX-336
title: Add `branch` field to ticket schema and types
status: Todo
priority: Medium
effort: XS
assignee: unassigned
tags:
  - feature
  - engine
  - portal
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.551Z'
    comment: Created as subtask of FLUX-292.
---
## Problem / Motivation

The ticket model has no field to store a git branch association. This subtask adds the schema support that all other parts depend on.

## Implementation Plan

1. Add optional `branch?: string` field to the `Task` interface in `portal/src/types.ts`.
2. Ensure `engine/src/task-store.ts` preserves the field during read/write without requiring it.
3. No migration needed — existing tickets simply won't have the field set.
