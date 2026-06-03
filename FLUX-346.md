---
priority: Medium
effort: M
tags:
  - refactor
  - portal
  - performance
assignee: unassigned
id: FLUX-346
title: 'Portal: split AppContext into focused contexts'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:29.797Z'
    comment: Created ticket.
---
## Problem

`portal/src/AppContext.tsx` (943 lines) owns routing, polling, theming, live-event diffing, read-state, parse errors, workspaces, and notifications. Every consumer re-renders on any change in any of these concerns.

## Plan

- Split into ~4 context providers stacked at the root:
  - `WorkspaceContext` — active workspace, switcher state, parse errors.
  - `TasksContext` — tasks cache, polling/SSE, live-event diffing.
  - `NotificationsContext` — notifications + read state.
  - `UIPrefsContext` — theme, view, sort/filter state, routing.
- Each context exposes a narrow hook. No god `useApp()`.
- Acceptance: a notification update does not re-render the board.
