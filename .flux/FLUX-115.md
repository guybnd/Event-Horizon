---
assignee: Agent
tags:
  - feature
  - ux
priority: Medium
effort: M
implementationLink: 0c3a705
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T03:56:08.778Z'
    comment: Created ticket.
  - type: comment
    id: c-flux115-plan
    author: Agent
    date: '2026-05-08T18:45:00.000Z'
    content: >
      **Plan:** Create `portal/src/components/ContextMenu.tsx` — a
      portal-rendered fixed-position menu triggered by `onContextMenu` on the
      TaskCard. State: `contextMenuPos | null` tracked in TaskCard; on open,
      close all existing popovers. Menu items: (1) Mark comments as read (only
      when unread exist); (2) Transition to > submenu (all statuses minus
      current, calls updateTask); (3) Copy agent command > submenu with 4 quick
      commands: Implement, Groom, Finish, Review — copies `<cmd> <FLUX-ID>` to
      clipboard; (4) Archive — sets status to archiveStatus; (5) Delete —
      two-step confirm inline; (6) Edit / Open — opens task modal. Dismiss on
      click-outside or Escape. No new API routes needed.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T18:45:00.000Z'
  - type: comment
    id: c-flux115-done
    author: Agent
    date: '2026-05-08T19:00:00.000Z'
    content: >
      **Implemented.** Created `portal/src/components/ContextMenu.tsx` — a
      portal-rendered right-click menu on task cards. Items: Edit/Open (respects
      boardCardOpenMode), Mark comments as read (shown only when unread exist),
      Transition to → inline submenu of all statuses, Copy agent command → 4
      quick commands (Implement, Groom, Finish, Review — copies `<cmd> FLUX-XX`
      to clipboard with a brief ✓ flash), Archive (sets archiveStatus), Delete
      (two-step confirm inline). Menu dismisses on click-outside or Escape.
      TaskCard wires `onContextMenu`, adds `contextMenuPos` state, and renders
      `<ContextMenu>` via portal. TypeScript clean.
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T19:00:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.332Z'
id: FLUX-115
title: add a mouse right-click menu on task cards
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.332Z'
releaseDocPath: release-notes/0.2.0
---

## Problem / Motivation

Task cards have no context menu, so common actions (archive, delete, status
transitions, mark-read, open) require opening the full modal. A right-click menu
gives power-user shortcuts without extra navigation.

## Implementation Plan

1. **`portal/src/components/ContextMenu.tsx`** (new) — portal-rendered menu
   component that receives `task`, `position`, and `onClose`. Renders inline
   submenus for "Transition to" and "Copy agent command". Handles archive/delete
   inline with a confirm step.
2. **`portal/src/components/TaskCard.tsx`** — add `onContextMenu` handler,
   `contextMenuPos` state, wire in `<ContextMenu>` portal. Prevent browser
   default context menu. Close on Escape.
