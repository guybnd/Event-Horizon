---
title: UI improvement to make clicking comment box on card more clear
status: Todo
createdBy: Guy
updatedBy: Guy
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
id: FLUX-120
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
