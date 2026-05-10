---
assignee: Agent
tags:
  - bug
priority: High
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-10T09:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T09:00:00.000Z'
    comment: Created ticket to document FLUX-174 regression and repair.
  - type: status_change
    from: Grooming
    to: Done
    user: Agent
    date: '2026-05-10T09:00:01.000Z'
  - type: comment
    user: Agent
    date: '2026-05-10T09:00:01.000Z'
    comment: >-
      Regression introduced by FLUX-174: useCallback/useRef hooks added for
      memoization were placed after the early return guard `if (!config ||
      (!isModalOpen && !modalTask)) return null` at line 908 in TaskModal.tsx.
      This violates React rules-of-hooks. When the modal is closed React takes
      the early return, skips those hooks, then on the next render when a ticket
      opens the hook count mismatches — React throws and the whole app goes
      blank. Fixed by moving the early return guard to after the last
      useCallback (line 1750), so all hooks are unconditionally called. Also
      removed unused filteredHistory from useMemo destructure and updated
      replyTextareaRef prop type in HistoryListProps to
      RefObject<HTMLTextAreaElement | null>.
    id: c-2026-05-10t09-00-01-000z
title: FLUX-174 regression repair — hooks-after-early-return caused blank screen
status: Done
createdBy: Agent
updatedBy: Agent
---

## What happened

FLUX-174 memoized `HistoryList` by converting plain functions to `useCallback`/`useRef` hooks. The converted hooks were placed **after** the early return guard at line 908:

```
if (!config || (!isModalOpen && !modalTask)) return null;
```

This violates React rules-of-hooks. When the modal closes React takes the early return and skips those hooks. The next time a ticket is opened the hook call count differs from the previous render — React throws and the whole app goes blank.

## Hooks placed after the guard (all added by FLUX-174)

- `sendReplyDirectly` — `useCallback`
- `attachReplyImageFilesRef` — `useRef`
- `handleReplyPaste`, `handleReplyDragOver`, `handleReplyDrop` — `useCallback`
- `handleToggleReply`, `handleCancelReply`, `handleToggleCollapsed`, `handleClearReplyAssetError` — `useCallback`

## Fix applied

Moved the early return from line 908 (before `linkedSubtasks`) to line 1750 — after the last `useCallback`. All hooks are now unconditionally called on every render.

Additional cleanup: removed `filteredHistory` from the `useMemo` destructure (unused variable TS error) and updated `replyTextareaRef` prop type in `HistoryListProps` to `RefObject<HTMLTextAreaElement | null>`.

**File:** `portal/src/components/TaskModal.tsx`
