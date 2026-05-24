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
    status: completed
    progress:
      - timestamp: '2026-05-24T14:41:09.325Z'
        message: Reading FLUX-286.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-286.md'
      - timestamp: '2026-05-24T14:41:14.714Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-24T14:41:15.428Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: next.*id|getNext|sequential|projectKey|FLUX-\d+
            path: 'C:\GitHub\EventHorizon\engine\src\routes\tasks.ts'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-24T14:41:15.816Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\config.json'
      - timestamp: '2026-05-24T14:41:29.729Z'
        message: Reading
        type: info
      - timestamp: '2026-05-24T14:41:44.731Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-24T14:41:57.052Z'
        message: Editing FLUX-286.md
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-286.md'
            old_string: >-
              ---

              id: FLUX-286

              title: "Engine: normalizeInlineSubtasks skips objects without id
              field"

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
                  comment: Created ticket. FLUX-281 subtasks were written as inline objects without id fields and silently skipped by the normalizer.
              ---


              ## Problem & Motivation


              The `normalizeInlineSubtasks()` function in
              `engine/src/task-store.ts` (line 138) checks `entry.id` to detect
              inline subtask objects. When an agent (e.g. Gemini CLI) writes
              subtasks as `{title, status, assignee}` without an `id` field, the
              normalization silently skips them — leaving broken inline objects
              in the YAML that the portal can't render as proper subtask links.


              This was previously addressed by FLUX-277 and FLUX-278, but the
              fix only handles the case where inline objects **have** an `id`.
              The id-less case was missed.


              ## Root Cause


              - Line 138: `subtasks.some((entry: any) => typeof entry ===
              'object' && entry !== null && entry.id)` — requires `entry.id`

              - Line 152: `if (typeof entry !== 'object' || !entry || !entry.id)
              continue;` — skips id-less objects entirely


              ## Proposed Fix


              When an inline subtask object has no `id`:

              1. Generate the next available ticket ID (same logic as the
              subtask creation endpoint).

              2. Create the `.flux/<newId>.md` file from the inline data (title,
              status, assignee, etc.).

              3. Replace the inline object with the new string ID in the
              parent's subtasks array.


              This makes the normalizer fully self-healing regardless of whether
              the agent included an `id` or not.


              ## Acceptance Criteria


              - [ ] Inline subtask objects **without** an `id` field are
              detected and normalized.

              - [ ] A new ticket file is generated with the next sequential ID.

              - [ ] The parent's `subtasks` array is rewritten to string IDs on
              disk.

              - [ ] Existing FLUX-277 behavior (objects with `id`) remains
              unchanged.

              - [ ] Add a log warning when normalizing id-less subtasks to aid
              debugging.
            new_string: >-
              ---

              id: FLUX-286

              title: "Engine: normalizeInlineSubtasks skips objects without id
              field"

              status: Todo

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
                  comment: Created ticket. FLUX-281 subtasks were written as inline objects without id fields and silently skipped by the normalizer.
                - type: comment
                  user: Agent
                  date: '2026-05-25T13:42:18.331Z'
                  comment: "Groomed: clear root cause at two sites in normalizeInlineSubtasks. Implementation plan added. Moving to Todo."
                - type: status_change
                  from: Grooming
                  to: Todo
                  user: Agent
                  date: '2026-05-25T13:42:18.331Z'
              ---


              ## Problem / Motivation


              When an agent writes subtasks as inline objects without an `id`
              field (e.g. `{title, status, assignee}`), the
              `normalizeInlineSubtasks()` function in `engine/src/task-store.ts`
              silently skips them. This leaves broken inline objects in the YAML
              that the portal cannot render. The FLUX-277/278 fix only handles
              objects that already have an `id`.


              ## Implementation Plan


              All changes are in `engine/src/task-store.ts`, function
              `normalizeInlineSubtasks` (line 135).


              1. **Broaden the detection condition** (line 139):
                 Change `entry.id` check to detect any non-null object entry — not just those with `id`:
                 ```ts
                 const hasInlineObjects = subtasks.some(
                   (entry: any) => typeof entry === 'object' && entry !== null
                 );
                 ```

              2. **Handle id-less objects in the loop** (line 147–194):
                 When `entry` is an object without `id`:
                 - Derive the project key from the parent's ID (e.g. `FLUX-286` → `FLUX`).
                 - Scan `tasksCache` for the max numeric ID with that project key (same logic as `POST /api/tasks` in `routes/tasks.ts` lines 84–91).
                 - Assign `nextId = <projectKey>-<max+1>`.
                 - Create the `.flux/<nextId>.md` file using the existing child-creation logic already in the function.
                 - Push `nextId` into `normalizedIds`.
                 - Log a warning: `[subtasks] Auto-created <nextId> from id-less inline subtask of <parentId>`.

              3. **Keep existing behavior intact**: Objects with `id` follow the
              current path unchanged. String entries pass through untouched.


              4. **Edge case**: If multiple id-less objects exist in one
              parent's subtasks, increment the counter for each within the same
              loop iteration to avoid collisions.


              ## Acceptance Criteria


              - [ ] Inline subtask objects without an `id` field are detected
              and normalized.

              - [ ] A new ticket file is generated with the next sequential ID.

              - [ ] The parent's `subtasks` array is rewritten to string IDs on
              disk.

              - [ ] Existing FLUX-277 behavior (objects with `id`) remains
              unchanged.

              - [ ] Log warning emitted when normalizing id-less subtasks.
      - timestamp: '2026-05-24T14:41:59.740Z'
        message: Editing
        type: info
      - timestamp: '2026-05-24T14:42:00.780Z'
        message: >-
          FLUX-286 is groomed and moved to **Todo**. The ticket now has a
          concrete implementation plan targeting two specific code sites in
          `normalizeInlineSubtasks`, with the id-generation logic mirrored from
          the `POST /api/tasks` route. Metadata was already correctly set (High
          priority, S effort, bug+engine tags).
    user: Claude Code
    date: '2026-05-24T14:40:58.020Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-24T14:42:00.781Z'
tokenMetadata:
  inputTokens: 151459
  outputTokens: 2529
  costUSD: 0.385723
  costIsEstimated: false
  cacheReadTokens: 107601
  cacheCreationTokens: 34942
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
