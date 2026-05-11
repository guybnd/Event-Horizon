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
    date: '2026-05-11T01:47:27.522Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-11T01:47:38.051Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-11T01:47:39.621Z'
    comment: Launched Claude Code session (07a0d27c).
  - type: comment
    user: Agent
    date: '2026-05-11T01:56:40.584Z'
    comment: >-
      Grooming complete. Root cause confirmed: PUT /api/tasks/:id drops
      submitted history entries when the submitted array is shorter than the
      server's authoritative history. Review agents send just the new comment
      entry (length 1), which gets truncated to nothing. Fix: add appendHistory
      field to PUT handler for appending without full-history rebase; update
      CodeReviewButton persona prompts to use it.
    id: c-2026-05-11t02-00-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T01:56:40.584Z'
  - type: activity
    user: Agent
    date: '2026-05-11T01:56:40.584Z'
    comment: >-
      Updated description. Changed priority from None to High. Changed effort
      from None to S.
  - type: activity
    user: Agent
    date: '2026-05-11T01:56:44.934Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T01:57:18.247Z'
    comment: Launched Claude Code session (9889f98c).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T01:57:41.503Z'
  - type: comment
    user: Agent
    date: '2026-05-11T01:57:41.504Z'
    comment: >-
      Starting implementation: (1) add appendHistory to PUT handler in
      engine/src/index.ts, (2) update REQUIRE_INPUT guard to check
      appendHistory, (3) update all 5 persona prompts in CodeReviewButton.tsx.
    id: c-2026-05-11t01-57-41-504z
  - type: activity
    user: Agent
    date: '2026-05-11T01:57:54.451Z'
    comment: Claude Code session stopped.
  - type: comment
    user: Guy
    comment: appendHistory smoke test — this comment should appear in history
    date: '2026-05-11T02:01:44.464Z'
    id: c-2026-05-11t02-01-44-464z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T02:01:51.233Z'
  - type: comment
    user: Agent
    date: '2026-05-11T02:01:51.234Z'
    comment: >-
      Fixed: engine/src/index.ts was extracting appendHistoryEntries but never
      pushing them into nextHistory before the write (line 2035). Added the
      missing for-loop to append after field-change messages. Updated all 5
      persona prompts in CodeReviewButton.tsx to use appendHistory instead of
      history. Smoke tested via curl — comment appears correctly with
      server-stamped date.
    id: c-2026-05-11t02-01-51-234z
  - type: activity
    user: Agent
    date: '2026-05-11T02:01:59.979Z'
    comment: Launched Claude Code session (34fa03a2).
  - type: activity
    user: Agent
    date: '2026-05-11T03:29:41.494Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-11T03:33:21.778Z'
    comment: Launched Claude Code session (bb5b4f62).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T03:33:46.524Z'
  - type: comment
    user: Agent
    date: '2026-05-11T03:33:46.525Z'
    comment: >-
      Closed. Fix shipped in commit d831d6e: added appendHistory support to PUT
      handler so review comments are appended directly without the rebase-slice
      logic discarding them. Updated all 5 persona prompts in
      CodeReviewButton.tsx to use appendHistory. REQUIRE_INPUT guard updated to
      recognise appendHistory comments. Validated with curl and TypeScript
      checks.
    id: c-2026-05-11t03-33-46-525z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T03:33:55.481Z'
    comment: >-
      FLUX-186 is closed. The fix (commit `d831d6e`) added `appendHistory` to
      the PUT handler so review comments bypass the rebase-slice logic, updated
      all 5 persona prompts in `CodeReviewButton.tsx`, and patched the
      `REQUIRE_INPUT` guard to recognise `appendHistory` comments. Ticket is now
      `Done`.
  - type: activity
    user: Agent
    date: '2026-05-11T03:38:41.545Z'
    comment: Claude Code session lost (engine restarted).
title: code review comments are discarded
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 1616270
  outputTokens: 31640
  costUSD: 1.151565
  costIsEstimated: false
---
## Root Cause

The `PUT /api/tasks/:id` handler uses a history-rebase strategy. It computes the authoritative existing history from the server cache, then extracts only entries beyond `existingHistory.length` from the submitted `history` array as "novel" entries.

When a review agent calls:
```
PUT /api/tasks/FLUX-184
{ "history": [{ "type": "comment", "comment": "review text" }] }
```

The server has 8 existing history entries. `nextHistory.slice(8)` on a 1-entry array returns `[]`. The comment is silently discarded.

**Affected files:**
- `engine/src/index.ts` — PUT handler (~line 1959)
- `portal/src/components/CodeReviewButton.tsx` — review persona prompts

---

## Fix

### 1. Engine: add `appendHistory` to PUT handler

In `engine/src/index.ts` PUT handler, before the `existingHistory` computation, extract and remove `appendHistory` from updates:

```typescript
const appendHistoryEntries: any[] = Array.isArray(updates.appendHistory) ? updates.appendHistory : [];
delete updates.appendHistory;
```

After `nextHistory = [...existingHistory, ...novelEntries]`, append the entries:

```typescript
for (const entry of appendHistoryEntries) {
  nextHistory.push({ ...entry, date: activityTimestamp });
}
```

### 2. Portal: update review persona prompts

In `portal/src/components/CodeReviewButton.tsx`, change all 5 persona prompt instructions from using `history: [...]` to `appendHistory: [{ type: "comment", user: "Agent", comment: "...", date: "2026-01-01" }]`.

The `date` field will be overwritten server-side.

Also ensure the REQUIRE_INPUT guard in the PUT handler supports `appendHistory` comments when transitioning to requireInputStatus (currently the guard only looks at `updates.history`, so needs updating too).

---

## Validation

1. `npx tsc --noEmit` in `engine/` and `portal/` — must pass
2. Start a code review session on a Ready ticket; verify the review comment appears in ticket history
3. Verify normal `PUT` with full history still works (no regression to grooming/implementation flows)
