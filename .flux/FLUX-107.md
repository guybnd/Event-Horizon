---
assignee: unassigned
tags:
  - bug
priority: Low
effort: XS
implementationLink: 'd3ac8f8'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T23:54:55.600Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T23:55:01.958Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-08T15:45:00.000Z'
    comment: >-
      Groomed. Problem: the title textarea in TaskModal only resizes via its
      onChange handler — so pre-existing long titles overflow the box when a
      ticket is first opened, because no resize is triggered on mount. Fix:
      add a `titleRef = useRef<HTMLTextAreaElement>(null)` and a `useEffect`
      that fires when `[isModalOpen, isFullView, title]` change, resetting
      height to auto then scrollHeight. Attach the same ref to both title
      textareas (full-view and popup) — only one is mounted at a time due to
      conditional rendering. Moving to In Progress.
    id: c-flux107-groom
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T15:45:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T15:50:00.000Z'
    comment: >-
      Implemented. Added `titleRef` and a `useEffect([isModalOpen, isFullView, title])`
      in TaskModal that resets the height to auto then scrollHeight whenever the
      modal opens or switches view. Attached `ref={titleRef}` to both title
      textareas (full-view sidebar and popup). No TS errors. Ready for review —
      open any ticket with a long title and confirm the box expands without typing.
    id: c-flux107-impl
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T15:50:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T15:55:00.000Z'
    comment: >-
      Done. Committed d3ac8f8. Title textarea now auto-resizes on modal open
      via a useEffect on [isModalOpen, isFullView, title]. User confirmed.
    id: c-flux107-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T15:55:00.000Z'
title: Title box not scaling sometimes
status: Done
createdBy: Guy
updatedBy: Agent
---

## Problem

The title textarea in the ticket modal only auto-resizes inside its `onChange` handler. When a ticket with a long title is opened, the textarea stays at one row height and the text overflows, because `onChange` never fires on mount — only on user input. This makes existing long titles appear clipped every time a ticket is opened.

## Fix

- Add `titleRef = useRef<HTMLTextAreaElement>(null)` alongside the existing refs in `TaskModal`.
- Add a `useEffect` with deps `[isModalOpen, isFullView, title]` that resets `titleRef.current.style.height` to `'auto'` then to `scrollHeight + 'px'` — matching the same resize pattern used in `onChange`.
- Attach `ref={titleRef}` to both title textarea elements (full-view sidebar ~line 1619 and popup ~line 1735). Only one is mounted at any time due to conditional rendering, so the same ref works for both.

## Validation

Open a ticket that has a long multi-word title without typing anything — the title box should expand to show the full text immediately on open.
