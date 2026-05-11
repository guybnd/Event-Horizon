---
assignee: unassigned
tags:
  - ui
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T05:08:16.243Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T05:09:59.357Z'
    comment: Launched Claude Code session (2cc2ba1e).
  - type: activity
    user: Agent
    date: '2026-05-11T05:10:55.533Z'
    comment: >-
      Updated description. Updated tags to ui. Changed priority from None to
      Low. Changed effort from None to XS.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T05:10:59.937Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T05:11:06.297Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T05:11:49.370Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:11:49.371Z'
    comment: >-
      Implementation complete. Added totalUnreadCount useMemo to AppContext
      (tasks × readComments × currentUser), exposed in AppState interface and
      provider value, and rendered it in the Unread pill in TaskViewControls as
      'Unread (N)' when N > 0. TypeScript passes clean. Two files changed:
      AppContext.tsx and TaskViewControls.tsx.
    id: c-2026-05-11t05-11-49-371z
  - type: activity
    user: Agent
    date: '2026-05-11T05:11:53.499Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-11T05:13:04.936Z'
    comment: >-
      it shows a bunch of unread even when none such are on the board. i assume
      it. counts stuff in history, archived and backlog too. it shouldnt. just
      board unread is interesting.
    replyTo: c-2026-05-11t05-11-49-371z
    id: c-2026-05-11t05-13-04-930z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-11T05:13:04.936Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-11T05:13:05.063Z'
    comment: Launched Claude Code session (72729740).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T05:14:15.219Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:14:15.220Z'
    comment: >-
      Fixed totalUnreadCount to only count board tasks. Added getArchiveStatus
      import to AppContext and updated the useMemo to skip tasks with Released
      status, the configured archive status, or any hiddenStatuses — matching
      the same exclusion logic used in Board.tsx. Count now reflects only active
      board tickets.
    id: c-2026-05-11t05-14-15-220z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:14:18.402Z'
    comment: >-
      The fix is in. `totalUnreadCount` in `AppContext.tsx:706` now filters out
      tasks with `Released` status, the configured archive status, and any
      `hiddenStatuses` before counting — matching the same scoping logic that
      `Board.tsx` uses for `boardTasks`. The unread pill count will now only
      reflect active board tickets.
  - type: activity
    user: Agent
    date: '2026-05-11T05:14:35.239Z'
    comment: Launched Claude Code session (87740aa6).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T05:14:58.364Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:14:58.365Z'
    comment: >-
      Shipped. Added totalUnreadCount derived value in AppContext (skips
      Released, archived, and hidden statuses) and rendered it in the Unread
      filter pill as 'Unread (N)'. Commit:
      6e5f6f08a0d66ad6999e9cd46e33d093e0350671
    id: c-2026-05-11t05-14-58-365z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:15:04.660Z'
    comment: >-
      FLUX-207 is done. Commit `6e5f6f0` — the Unread pill now shows `Unread
      (N)` when there are unread comments on active board tasks, and falls back
      to plain `Unread` when the count is zero.
  - type: activity
    user: Agent
    date: '2026-05-11T05:20:31.512Z'
    comment: Claude Code session lost (engine restarted).
title: '''unread'' filter pill should show how many unread messages there are '
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 803021
  outputTokens: 5107
  costUSD: 0.416381
  costIsEstimated: false
---
## Implementation Plan

Add a count badge to the "Unread" filter pill in `TaskViewControls` showing the total number of unread comments across all tasks.

### Touchpoints

- `portal/src/AppContext.tsx` — compute `totalUnreadCount` as a derived value using `useMemo` over `tasks`, `readComments`, and `currentUser`. Add to `AppState` interface and expose in provider value.
- `portal/src/components/TaskViewControls.tsx` — consume `totalUnreadCount` from context and render it inside the Unread pill when > 0.

### Logic

For `totalUnreadCount`:
```
tasks.flatMap(task => 
  (task.history ?? []).filter(e =>
    e.type === "comment" &&
    e.id &&
    e.user !== currentUser &&
    !(readComments[task.id] ?? []).includes(e.id)
  )
).length
```

### Pill rendering

When `totalUnreadCount > 0`, render a small badge number after "Unread" text: `Unread (N)` or a badge chip. Match the existing pattern used in the Filters button (`Filters (N)`).

### Validation

- Verify count updates when opening a ticket and reading comments (count decreases).
- Verify pill shows no count when all comments are read or no comments exist.

).length
```

### Pill rendering

When `totalUnreadCount > 0`, render a small badge number after "Unread" text: `Unread (N)` or a badge chip. Match the existing pattern used in the Filters button (`Filters (N)`).

### Validation

- Verify count updates when opening a ticket and reading comments (count decreases).
- Verify pill shows no count when all comments are read or no comments exist.
