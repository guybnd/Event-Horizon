---
title: UI improvement to make clicking comment box on card more clear
status: Released
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - ui
  - ux
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T05:53:47.250Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-08T05:54:19.936Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Plan: in TaskCard.tsx, replace the comment badge so it (1) is always
      visible even when there are no comments (ghost style when empty, opens
      modal to add comment), (2) is bigger (px-2.5 py-1, icon w-3.5 h-3.5), (3)
      animates on hover/click (hover:scale-105 active:scale-95), and (4) has
      stronger hover color in the read/gray state.
    id: c-flux120-plan
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:01:00.000Z'
    comment: >-
      Done. TaskCard.tsx comment badge updated: always visible (ghost style on
      zero-comment cards, opens modal to add comment), bigger hit area (px-2.5
      py-1, icon w-3.5 h-3.5), hover scale animation (hover:scale-105
      active:scale-95), and hover colour now shifts to primary/violet on read
      state instead of staying grey. Amber unread state gets stronger hover
      background. Build clean.
    id: c-flux120-done
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T00:01:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.337Z'
id: FLUX-120
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.337Z'
releaseDocPath: release-notes/0.2.0
---

## Summary
The comment box button on a ticket card is not obviously clickable. We need to improve its visual affordance with size, hover states, and animations.

## Requirements

### 1. Enhance Comment Box Visual Affordance
- Increase the hit area/size of the comment button on the card.
- Add clear visual cues that it is interactive (e.g., hover background change, cursor change, scale animation).
- Ensure the contrast and styling stand out appropriately against the card background.

## Acceptance Criteria
- [ ] The comment button on the card is visually distinct and obvious.
- [ ] Hovering over the button provides immediate, satisfying feedback (animation or highlight).

## Likely Affected Areas
- `portal/src/components/TaskCard.tsx` (or similar card component).
- CSS/Tailwind classes for the comment button.

## Notes
- Goal is to reduce user friction by ensuring interactive elements clearly look interactive.

## Original Request
it might not be bvious to user that this button is clickable so maybe make it bigger and have some animation or pop idk
