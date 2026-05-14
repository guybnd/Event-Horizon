---
assignee: unassigned
tags: []
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-12T08:16:58.221Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-13T04:37:18.327Z'
    comment: Updated title.
  - type: activity
    user: Agent
    date: '2026-05-13T13:39:15.215Z'
    comment: Launched Claude Code session (55922dbb).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T13:41:01.557Z'
  - type: comment
    user: Agent
    date: '2026-05-13T13:41:01.560Z'
    comment: >-
      Grooming complete. Root cause: totalUnreadCount in AppContext.tsx sums
      unread messages per ticket; should instead count tickets with at least one
      unread message. One-line fix in the reduce callback (some instead of
      filter+length). Plan written to ticket body.
    id: c-2026-05-13t13-41-01-560z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T13:41:05.113Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T13:41:13.691Z'
  - type: comment
    user: Agent
    date: '2026-05-13T13:41:13.693Z'
    comment: >-
      Fixed: changed totalUnreadCount in AppContext.tsx to count tickets with at
      least one unread comment (using .some()) instead of summing all unread
      messages. The Unread button badge now shows ticket count. Filter behaviour
      unchanged. One-line change, no other consumers affected.
    id: c-2026-05-13t13-41-13-693z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T13:41:16.840Z'
    comment: >-
      Done. The fix is a single-line change in `portal/src/AppContext.tsx:753` —
      replaced `.filter(...).length` with `.some(...)` so `totalUnreadCount` now
      counts tickets with at least one unread comment instead of summing all
      unread messages. Ticket is in **Ready** for your review.
  - type: activity
    user: Agent
    date: '2026-05-13T13:41:16.843Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-14T02:05:09.798Z'
    comment: 'you failed, try again'
    replyTo: c-2026-05-13t13-41-13-693z
    id: c-2026-05-14t02-05-09-794z
  - type: status_change
    from: Ready
    to: Todo
    user: Guy
    date: '2026-05-14T02:07:56.772Z'
title: >-
  unread button in board should note the amount of. tickets that are unread not
  the messages amount
status: Todo
createdBy: Guy
updatedBy: Guy
tokenMetadata:
  inputTokens: 234900
  outputTokens: 2926
  costUSD: 0.317438
  costIsEstimated: false
  cacheReadTokens: 206981
  cacheCreationTokens: 27783
order: 163
---
## Plan\n\nThe unread button in the board shows a count of total unread messages (comments), but it should show the count of tickets that have unread messages.\n\n### Root Cause\n\n`AppContext.tsx` (lines 745–758) computes `totalUnreadCount` by summing the number of unread comments per task. The fix is to instead count the number of tasks that have at least one unread comment.\n\n### Change\n\n**File:** `portal/src/AppContext.tsx`\n\nIn the `totalUnreadCount` memo, replace the per-task comment count accumulation with a boolean check — increment by 1 if the task has any unread comment, skip otherwise.\n\nBefore:\n```ts\nconst count = (task.history ?? []).filter(\n  e => e.type === 'comment' && e.id && e.user !== currentUser && !readIds.has(e.id)\n).length;\nreturn sum + count;\n```\n\nAfter:\n```ts\nconst hasUnread = (task.history ?? []).some(\n  e => e.type === 'comment' && e.id && e.user !== currentUser && !readIds.has(e.id)\n);\nreturn sum + (hasUnread ? 1 : 0);\n```\n\n### Validation\n\n- Confirm the Unread button label changes from message count to ticket count.\n- Confirm the filter still works (shows tickets with unread messages).\n- No other consumers of `totalUnreadCount` need updating — it is only used to display the badge label in `TaskViewControls.tsx`.
