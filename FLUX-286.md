---
id: FLUX-286
title: 'Engine: normalizeInlineSubtasks skips objects without id field'
status: Grooming
priority: High
effort: S
assignee: unassigned
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-24T14:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-24T14:00:00.000Z'
    comment: >-
      Created ticket. FLUX-281 subtasks were written as inline objects without
      id fields and silently skipped by the normalizer.
  - type: agent_session
    sessionId: 6e3c4e31-6715-4c84-b29e-e26cbfda063d
    startedAt: '2026-05-24T14:40:58.020Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-24T14:40:58.020Z'
---

## Problem & Motivation

The `normalizeInlineSubtasks()` function in `engine/src/task-store.ts` (line 138) checks `entry.id` to detect inline subtask objects. When an agent (e.g. Gemini CLI) writes subtasks as `{title, status, assignee}` without an `id` field, the normalization silently skips them — leaving broken inline objects in the YAML that the portal can't render as proper subtask links.

This was previously addressed by FLUX-277 and FLUX-278, but the fix only handles the case where inline objects **have** an `id`. The id-less case was missed.

## Root Cause

- Line 138: `subtasks.some((entry: any) => typeof entry === 'object' && entry !== null && entry.id)` — requires `entry.id`
- Line 152: `if (typeof entry !== 'object' || !entry || !entry.id) continue;` — skips id-less objects entirely

## Proposed Fix

When an inline subtask object has no `id`:
1. Generate the next available ticket ID (same logic as the subtask creation endpoint).
2. Create the `.flux/<newId>.md` file from the inline data (title, status, assignee, etc.).
3. Replace the inline object with the new string ID in the parent's subtasks array.

This makes the normalizer fully self-healing regardless of whether the agent included an `id` or not.

## Acceptance Criteria

- [ ] Inline subtask objects **without** an `id` field are detected and normalized.
- [ ] A new ticket file is generated with the next sequential ID.
- [ ] The parent's `subtasks` array is rewritten to string IDs on disk.
- [ ] Existing FLUX-277 behavior (objects with `id`) remains unchanged.
- [ ] Add a log warning when normalizing id-less subtasks to aid debugging.
