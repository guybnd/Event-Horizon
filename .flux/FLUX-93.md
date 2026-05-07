---
assignee: unassigned
tags:
  - feature
  - ux
priority: Low
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T13:53:26.203Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Plan: add a comment count badge to TaskCard. Hover shows a
      scrollable popover (similar to the existing description preview portal).
      Unread tracking needs a persistence strategy — localStorage keyed by
      userId+ticketId+commentId is the simplest approach without a backend
      change. Glowing border on cards with unread comments. Clicking a comment
      in the popover marks it read. Medium effort due to the unread-state layer.
    id: c-flux93-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
id: FLUX-93
title: add comments preview to card display
status: Todo
createdBy: Guy
updatedBy: Agent
---

# Goal

Board task cards should surface comment activity without opening the full ticket:
- Comment count badge on the card.
- Indicator if there are unread comments.
- Hover popover with scrollable comment list (like the description hover preview).
- Clicking an unread comment in the popover marks it as read.
- Cards with unread comments get a glowing border.

# Implementation Plan

1. **Unread tracking:** Use `localStorage` keyed as `flux:read:<userId>:<ticketId>:<commentId>`. On load, compare stored read IDs against the ticket's comment history to determine which are unread.

2. **TaskCard badge (`portal/src/components/TaskCard.tsx`):**
   - Count comments (`history.filter(e => e.type === 'comment')`).
   - Show a small badge with the count.
   - Add a glow ring class (e.g. `ring-2 ring-amber-400 animate-pulse`) to the card border when there are unread comments.

3. **Hover popover:**
   - Reuse the portal-based hover pattern from the existing description preview.
   - Render comments in a scrollable list, newest last.
   - Unread comments highlighted with a subtle background.
   - On hover, mark all as read (or on individual click per comment).

4. **TaskCard changes are self-contained** — no backend changes needed.

# Validation

- Card shows comment count when ticket has comments.
- New comment (added via modal) causes badge to show unread indicator on next board view.
- Hovering the badge shows the comment popover.
- After hovering, unread indicator clears.
- Glowing border visible on cards with unread comments, absent otherwise.
