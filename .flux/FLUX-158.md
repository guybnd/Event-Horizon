---
assignee: unassigned
tags:
  - bug
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:29:54.041Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-09T04:29:58.758Z'
    comment: Launched Claude Code session (ebf1ce0f).
  - type: comment
    user: Agent
    date: '2026-05-09T04:35:00.000Z'
    comment: >-
      Investigated the bug. Root cause: PUT /api/tasks/:id does a
      last-write-wins replace of the history array. When an agent has a stale
      cache snapshot and writes back, any comments added by the user between the
      agent's read and write are dropped. Same issue exists in
      updateTaskWithHistory() which reads only from tasksCache. Fix: (1) add a
      stale-prefix merge in the PUT handler using historyPrefixMatches(); (2)
      have updateTaskWithHistory() read fresh from disk before appending
      entries.
    id: c-2026-05-09t04-35-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T04:35:01.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T04:36:00.000Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T04:34:11.999Z'
  - type: activity
    user: Agent
    date: '2026-05-09T07:46:00.007Z'
    comment: Launched Claude Code session (413b88b6).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T07:46:42.692Z'
  - type: comment
    user: Agent
    date: '2026-05-09T07:46:42.693Z'
    comment: >-
      Fixed. Two changes in engine/src/index.ts: (1) updateTaskWithHistory() now
      reads the ticket file fresh from disk before building nextHistory, so any
      user comments added after the agent cached the task are included in the
      base rather than silently dropped; (2) the PUT /api/tasks/:id handler now
      calls historyPrefixMatches() to detect stale snapshots and rebases novel
      caller entries onto the current history instead of replacing it. Both
      paths eliminate the last-write-wins race. Commit: c6a5152.
    id: c-2026-05-09t07-46-42-693z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.358Z'
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
title: >-
  sometimes my latest comments or messages are just deleted by an in progress
  agent session.
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.358Z'
releaseDocPath: release-notes/0.2.0
---
## Problem

When an agent session is in progress and the user adds a comment or message via the portal UI, the agent's subsequent `PUT /api/tasks/:id` call can overwrite those new entries. This is a last-write-wins race on the `history` array.

### Root cause

In `engine/src/index.ts`, the `PUT /api/tasks/:id` handler (line 1802) merges `{ ...task, ...updates }` — so whatever `history` array the caller sends **replaces** the in-memory cache history. There is no check for whether the caller's snapshot is stale.

The same issue exists in `updateTaskWithHistory()` (line 261): it reads from `tasksCache` (not disk), then appends its new entries, so any entries added after the cache was last set are silently dropped when the function writes back.

### Race scenario

1. Agent session starts — sees history `[A, B]`.
2. User posts a comment — engine writes `[A, B, C]` to disk and cache.
3. Agent calls `updateTaskWithHistory()` — reads `[A, B]` from its stale cache snapshot, appends its entry → writes `[A, B, agentEntry]` → **C is lost**.

## Fix

### 1. Make `PUT /api/tasks/:id` merge stale history

After line 1806 (`let nextHistory = normalizeHistoryEntries(frontmatter.history || []).history`), check whether the incoming history is a prefix of `existingHistory`. If it is, the caller had a stale snapshot: use `existingHistory` as the base and append only the novel entries from the request (those beyond the prefix length).

```ts
// If the request history is a prefix of existingHistory, the caller had a stale
// snapshot — take existingHistory as base and re-apply the novel entries.
if (historyPrefixMatches(nextHistory, existingHistory)) {
  const novelEntries = nextHistory.slice(existingHistory.length);
  nextHistory = [...existingHistory, ...novelEntries];
}
```

### 2. Make `updateTaskWithHistory()` read from disk

Replace the cache-only read at line 261 with a fresh disk read so the function always works from the current persisted state:

```ts
// Read fresh from disk to avoid stomping concurrent writes
const rawFile = await fs.readFile(task._path, 'utf-8');
const parsed = matter(rawFile);
const freshFrontmatter = parsed.data as any;
```

Then base `nextHistory` on `freshFrontmatter.history` instead of `frontmatter.history` from the cache.

## Files to change

- `engine/src/index.ts`
  - `PUT /api/tasks/:id` handler (~line 1806): add stale-prefix merge
  - `updateTaskWithHistory()` (~line 261): read from disk before building `nextHistory`

## Validation

- Open a ticket in the portal and add a comment while an agent session is active.
- Trigger the agent to post a follow-up history entry.
- Confirm both entries are present in the ticket after the agent write.
- Confirm no regression in normal comment posting or status transitions.
