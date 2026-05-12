---
assignee: unassigned
tags:
  - bug
  - portal
  - ui
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:44:09.421Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-09T03:44:12.296Z'
    comment: Updated tags to bug.
  - type: activity
    user: Agent
    date: '2026-05-09T04:25:19.699Z'
    comment: Launched Claude Code session (ef226716).
  - type: comment
    user: Agent
    date: '2026-05-09T04:30:00.000Z'
    comment: >-
      Groomed. Root cause: AppContext early-return guard prevents modalTask from
      refreshing while modal is open. Fix: add a second refresh effect in
      AppContext that syncs modalTask from tasks while the modal is open; split
      the TaskModal init effect so draft state only resets on new-ticket open,
      not on live data refreshes. Effort: S.
    id: c-2026-05-09t04-30-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T04:30:01.000Z'
  - type: activity
    user: Agent
    date: '2026-05-09T04:32:37.500Z'
    comment: >-
      Updated description. Updated tags to bug, portal, ui. Changed priority
      from None to Medium. Changed effort from None to S.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T04:32:51.384Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T04:33:34.970Z'
  - type: comment
    user: Guy
    date: '2026-05-09T07:46:44.477Z'
    comment: >-
      this now kind of resets the whole view for amoment instead of breaking so
      it works but still not ideal. i'd imagine we just see the status update in
      the ticket inst ead of reloading the whole page?
    replyTo: c-2026-05-09t04-30-00-000z
    id: c-2026-05-09t07-46-44-477z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-09T07:46:44.477Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-09T07:46:44.568Z'
    comment: Launched Claude Code session (e60fb2fa).
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T07:49:27.270Z'
    comment: >-
      Clean. The changes:


      1. **AppContext.tsx** — the refresh effect now compares key fields before
      calling `setModalTask`, so it only fires when something actually changed
      (not every 3-second poll).


      2. **TaskModal.tsx** — the sync effect now distinguishes between a new
      ticket opening (full reset) and a live refresh of the same ticket (only
      update fields that actually differ, using functional setters to compare
      against current state). This means if only `status` changed, only
      `setStatus` triggers a state update — no re-render churn from the
      unchanged fields.


      The result: when an agent updates a ticket while the modal is open, you'll
      see just the status (and any other changed fields) update in place — no
      whole-modal flash.
  - type: comment
    user: Guy
    date: '2026-05-09T07:55:41.150Z'
    comment: finish task
    id: c-2026-05-09t07-55-41-150z
  - type: activity
    user: Agent
    date: '2026-05-09T07:55:43.312Z'
    comment: Launched Claude Code session (d5db09fe).
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-09T07:56:09.441Z'
  - type: comment
    user: Agent
    date: '2026-05-09T07:56:09.441Z'
    comment: >-
      Implemented live modal refresh: AppContext now keeps modalTask in sync
      with polled tasks while open, and TaskModal distinguishes new-ticket opens
      (full reset) from same-ticket refreshes (field-only update). In-progress
      comment drafts are preserved across agent updates. Commit: 9a5b31b
    id: c-2026-05-09t07-56-09-441z
  - type: activity
    user: Agent
    date: '2026-05-09T07:56:15.079Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.356Z'
title: >-
  card moving status by an agent hwile its currently open breaks the pop up
  display
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 7
  outputTokens: 710
  costUSD: 0.09427
  costIsEstimated: false
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.356Z'
releaseDocPath: release-notes/0.2.0
---
## Problem

When a ticket modal is open and an agent updates the ticket status via the API, the modal display stays stale — the status selector still shows the old value, history does not update, and other agent-edited fields are not reflected.

## Root Cause

AppContext.tsx polls every 3 seconds and detects changes in the `tasks` array. However, the effect that syncs `modalTask` from `tasks` (~line 660) has an early-return guard:

```js
if (isModalOpen && modalTask?.id === ticketId) return;
```

This means `modalTask` is never refreshed while the modal is already open for the same ticket, so all local field state in TaskModal stays frozen at the snapshot from when the modal opened.

TaskModal.tsx initialises local state (`status`, `body`, history etc.) from `modalTask` in one `useEffect([modalTask])`. Since `modalTask` never updates while open, the fields stay stale.

## Fix

### portal/src/AppContext.tsx

Split the single effect into two:
1. **Open effect** (existing): run when the modal is closed and a `?ticket=` URL param exists — opens the modal with the found task (existing guard intact).
2. **Refresh effect** (new): when the modal IS open, keep `modalTask` in sync with fresh data from the `tasks` array whenever `tasks` changes.

The refresh effect:
```js
useEffect(() => {
  if (!isModalOpen || !modalTask?.id) return;
  const fresh = tasks.find((t) => t.id === modalTask.id);
  if (fresh) setModalTask(fresh);
}, [tasks]);
```

### portal/src/components/TaskModal.tsx

The `useEffect([modalTask])` currently resets ALL local state including in-progress drafts on every `modalTask` change. After the AppContext fix, this runs on every poll, wiping the user's in-progress comment text.

Fix: track the previous task ID with a ref. When `modalTask.id` changes (new ticket opened), run full reset including draft state. When `modalTask` updates but the ID is the same (live refresh), only update data fields: `status`, `title`, `body`, `assignee`, `tags`, `priority`, `effort`, `implementationLink`, `subtasks`, `cliSession`.

## Files

- `portal/src/AppContext.tsx`
- `portal/src/components/TaskModal.tsx`

## Validation

1. Open a ticket modal in the portal.
2. Start typing a comment (do not submit).
3. Via the API, change the ticket status and add a history entry.
4. Within 3 seconds: modal shows new status and new history entry; in-progress comment text is preserved.
