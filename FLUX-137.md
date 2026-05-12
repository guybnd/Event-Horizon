---
assignee: unassigned
tags:
  - portal
priority: Low
effort: XS
implementationLink: 6c70648
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:30:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T04:30:00.000Z'
    comment: >-
      Completed. Added `&& c.user !== currentUser` guard in three places in
      TaskCard.tsx (unreadComments filter, isUnreadItem for top-level comments,
      isUnreadReply for replies) and in TaskModal.tsx (unreadCommentCount
      filter). Own comments no longer show unread badge or amber highlight.
      Commit: 6c70648.
    id: c-2026-05-09t04-30-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:30:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:21:22.188Z'
  - type: activity
    user: Agent
    date: '2026-05-09T04:21:22.188Z'
    comment: Updated implementation link.
  - type: activity
    user: Agent
    date: '2026-05-09T04:21:24.906Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.347Z'
title: mark user made comments as already read
status: Released
createdBy: Guy
updatedBy: Agent
order: 0
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.347Z'
releaseDocPath: release-notes/0.2.0
---
## Problem

When the current user posts a comment, it appears as "unread" for themselves — showing an unread badge and amber highlight even though they authored the message. This is a false positive that creates noise.

## Solution

Exclude comments authored by the current user from the unread set. The check is performed at the point of computing unread comments in the two display surfaces:

- `portal/src/components/TaskCard.tsx` — `unreadComments` filter (line 159)
- `portal/src/components/TaskModal.tsx` — `unreadCommentCount` filter (line 1385)

Filter condition added: `&& c.user !== currentUser` (TaskCard) and `&& e.user !== currentUser` (TaskModal).

`currentUser` is already in scope at both locations, so no additional plumbing is needed.

## Validation

- Post a comment as current user → no unread badge or amber highlight appears for own comment
- Comments from other users (Agent, etc.) still show as unread
- Existing read state entries are unaffected
d badge or amber highlight appears for own comment
- Comments from other users (Agent, etc.) still show as unread
- Existing read state entries are unaffected
