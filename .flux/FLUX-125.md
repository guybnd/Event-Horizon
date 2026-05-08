---
title: Fix the top bar layout
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - bug
  - ui
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T07:28:21.327Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-08T07:28:41.606Z'
    comment: Updated description.
id: FLUX-125
---

## Summary
The top bar layout is currently broken and wrapping incorrectly. It should be constrained to a single row to maintain a clean UI.

## Requirements

### 1. Fix Top Bar Wrapping
- Inspect the top bar container and ensure it uses proper flexbox/grid styling to prevent wrapping.
- Force all elements in the top bar to remain on a single horizontal row (`flex-wrap: nowrap` or similar).
- Implement proper text truncation or overflow handling if the screen is too narrow, rather than allowing items to flow to a second line.

## Acceptance Criteria
- [ ] The top bar is perfectly aligned in a single row.
- [ ] Shrinking the window does not cause the top bar layout to break or wrap onto multiple lines.

## Likely Affected Areas
- `portal/src/components/Header.tsx` or similar layout component.
- Corresponding CSS/Tailwind classes for the header.

## Notes
- See attached image in original description for context: `assets/FLUX-125/image.png`.

## Original Request
the layout broke: it shoud all be one row
![image](assets/FLUX-125/image.png)
