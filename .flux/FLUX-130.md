---
assignee: Agent
tags:
  - bug
  - backend
  - agent-workflow
  - reliability
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T08:33:18.521Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-09T08:50:15.850Z'
    comment: Launched Claude Code session (845255e0).
  - type: activity
    user: Agent
    date: '1970-01-01T00:00:00.000Z'
    comment: FABRICATION_TEST_PROBE_2
  - type: activity
    user: Agent
    date: '2026-05-09T08:54:12.760Z'
    comment: Grooming complete. Ticket moved to Todo.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T08:54:12.760Z'
  - type: activity
    user: Agent
    date: '2026-05-09T08:54:12.760Z'
    comment: >-
      Starting implementation: stamping novel history entry dates with
      server-side timestamp in PUT /api/tasks/:id handler.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T08:54:12.760Z'
  - type: activity
    user: Agent
    date: '2026-05-09T08:54:25.295Z'
    comment: FINAL_FABRICATION_TEST
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T08:55:01.596Z'
  - type: activity
    user: Agent
    date: '2026-05-09T08:55:18.321Z'
    comment: VALIDATION_PROBE_POST_FIX
  - type: comment
    user: Agent
    date: '2026-05-09T08:55:39.361Z'
    comment: >-
      Fix complete. Simplified history rebase block: always use existingHistory
      as authoritative prefix, stamp all novel entries with activityTimestamp.
      Eliminates the gap where equal-length/mismatched nextHistory bypassed both
      conditional branches. Validated: probe with date 1984-01-01 returned
      2026-05-09 server timestamp.
    id: c-2026-05-09t08-55-39-361z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T09:06:31.533Z'
  - type: comment
    user: Agent
    date: '2026-05-09T09:06:31.534Z'
    comment: >-
      Fix complete: engine now stamps all novel history entry dates with
      server-side timestamp, eliminating agent-hallucinated dates. Commit
      0a81b6a.
    id: c-2026-05-09t09-06-31-534z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T09:06:34.752Z'
title: need find a way to enforce better timestamps
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.1
releasedAt: '2026-05-09T09:06:34.752Z'
releaseDocPath: release-notes/0.2.1
---
## Problem

Agents hallucinate `date` fields when sending history entries to `PUT /api/tasks/:id`. The engine accepts novel history entries verbatim without overriding their timestamps, allowing fabricated dates to persist in ticket history.

## Root Cause

In `engine/src/index.ts`, the `PUT /api/tasks/:id` handler identifies novel history entries (entries beyond the existing history length after rebasing) and appends them directly. The `date` field on these novel entries is never overwritten with a server-side timestamp.

Server-generated entries (status changes, field-change activity) already use `new Date().toISOString()` — those are correct. Only agent-supplied novel history entries have this gap.

## Fix

In `engine/src/index.ts`, after the `historyPrefixMatches` rebase block, stamp the `date` field of every novel entry with `activityTimestamp` (which is already computed as `new Date().toISOString()` just below that block).

Specifically, move the `activityTimestamp` declaration above the rebase block and then replace each novel entry's `date` field:

```ts
// Before (around line 1899-1901):
if (historyPrefixMatches(nextHistory, existingHistory)) {
  const novelEntries = nextHistory.slice(existingHistory.length);
  nextHistory = [...existingHistory, ...novelEntries];
}

const activityTimestamp = new Date().toISOString();

// After:
const activityTimestamp = new Date().toISOString();

if (historyPrefixMatches(nextHistory, existingHistory)) {
  const novelEntries = nextHistory.slice(existingHistory.length).map((entry) => ({
    ...entry,
    date: activityTimestamp,
  }));
  nextHistory = [...existingHistory, ...novelEntries];
}
```

## Scope

- `engine/src/index.ts`: one change to the `PUT /api/tasks/:id` handler
- No portal changes needed
- No schema changes needed

## Validation

1. Send a `PUT` with a novel history entry whose `date` is a fabricated value (e.g. `"2020-01-01T00:00:00.000Z"`)
2. Confirm the saved ticket shows the actual server timestamp, not the fabricated one
3. Confirm status changes and field activity entries are still stamped correctly
