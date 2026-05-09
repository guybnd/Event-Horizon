---
title: Fix the top bar layout
status: Released
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - bug
  - ui
priority: High
effort: S
implementationLink: ff26f10220abdff9a22c1f49e5bf81c1094577dc
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
  - type: comment
    user: Antigravity
    date: '2026-05-08T08:33:00.000Z'
    comment: >-
      Fixed header wrapping issue by transitioning layout to a single
      horizontally-scrollable flex row (`overflow-x-auto`). Ensured the left
      segment (branding/nav) is `shrink-0` to maintain fidelity, while the right
      segment leverages `flex-1 min-w-0` to allow the search input to correctly
      truncate down to mobile widths without breaking the flex container onto
      multiple rows. Committed in `ff26f10220abdff9a22c1f49e5bf81c1094577dc`.
    id: c-2026-05-08t08-33-00-000z
  - type: status_change
    from: Todo
    to: Done
    user: Antigravity
    date: '2026-05-08T08:33:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.341Z'
id: FLUX-125
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.341Z'
releaseDocPath: release-notes/0.2.0
---

## Summary
The top bar layout is currently broken and wrapping incorrectly. It should be constrained to a single row to maintain a clean UI.

## Requirements

### 1. Fix Top Bar Wrapping
- Inspect the top bar container and ensure it uses proper flexbox/grid styling to prevent wrapping.
- Force all elements in the top bar to remain on a single horizontal row (`flex-wrap: nowrap` or similar).
- Implement proper text truncation or overflow handling if the screen is too narrow, rather than allowing items to flow to a second line.

## Acceptance Criteria
- [x] The top bar is perfectly aligned in a single row.
- [x] Shrinking the window does not cause the top bar layout to break or wrap onto multiple lines.

## Likely Affected Areas
- `portal/src/components/Header.tsx` or similar layout component.
- Corresponding CSS/Tailwind classes for the header.

## Notes
- See attached image in original description for context: `assets/FLUX-125/image.png`.

## Original Request
the layout broke: it shoud all be one row
![image](assets/FLUX-125/image.png)
