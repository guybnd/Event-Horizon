---
assignee: Agent
tags:
  - feature
  - ux
priority: Medium
effort: S
implementationLink: 5de4ab1
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T04:04:14.192Z'
    comment: Created ticket.
  - type: comment
    id: c-flux116-plan
    user: Agent
    date: '2026-05-08T18:00:00.000Z'
    comment: >
      **Plan:** (1) Redesign TaskViewControls to a single always-on-row layout —
      remove the responsive flex-col/xl:flex-row breakpoints so icon+title,
      search, and action buttons stay on one line at all widths. Shrink search
      to a fixed ~176px width instead of flex-1. Remove the "X active" count
      badge (redundant). (2) Add a prominent "Unread only" pill/toggle button
      between search and Filters that, when active, filters to tasks with ≥1
      unread comment (comment IDs not in readComments[task.id]) OR tasks in the
      requireInputStatus. State lives in AppContext (filterUnreadOnly bool).
      taskSearch.ts TaskFilterState gets filterUnreadOnly, readComments, and
      requireInputStatus optional fields. Board.tsx and BacklogScreen.tsx pass
      them through. Active filter count includes filterUnreadOnly.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T18:00:00.000Z'
  - type: comment
    id: c-flux116-done
    user: Agent
    date: '2026-05-08T18:30:00.000Z'
    comment: >
      **Implemented.** TaskViewControls redesigned to a single `flex
      items-center gap-2 flex-wrap` row — no more two-line responsive layout.
      Search bar shrunk to `w-44` fixed width. The "X active" count badge
      removed. New "Unread" toggle pill (Inbox icon, turns blue when active)
      added between search and Filters. When active it filters to tasks with ≥1
      unread comment OR tasks in requireInputStatus. filterUnreadOnly bool added
      to AppContext (with URL param `?unread=1`), TaskFilterState, Board, and
      BacklogScreen. TypeScript clean.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T18:30:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T18:31:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.333Z'
id: FLUX-116
title: board filter improvements
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.333Z'
releaseDocPath: release-notes/0.2.0
---

## Problem / Motivation

The board filter bar spans two lines and wastes vertical space. The search input
expands to fill all available width unnecessarily. There is no quick way to see
only tickets with unread comments or pending agent prompts.

## Implementation Plan

1. **`taskSearch.ts`** — add `filterUnreadOnly`, `readComments`, and
   `requireInputStatus` to `TaskFilterState`; apply the filter inside
   `filterAndSortTasks`.
2. **`AppContext.tsx`** — add `filterUnreadOnly: boolean` state, expose
   `setFilterUnreadOnly`, include in `clearTaskFilters` and URL params.
3. **`Board.tsx` / `BacklogScreen.tsx`** — destructure `filterUnreadOnly`,
   `readComments`, `config` and pass all new fields through to
   `filterAndSortTasks`.
4. **`TaskViewControls.tsx`** — replace responsive flex-col layout with a
   single `flex items-center gap-2 flex-wrap` row; set search to fixed
   `w-44`; remove the active-count badge; add an "Unread" toggle pill button
   (uses `Inbox` icon, turns blue when active) between search and Filters.
