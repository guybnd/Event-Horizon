---
assignee: unassigned
tags:
  - docs
  - ui
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T04:43:04.235Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T05:20:41.847Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-07T05:23:46.190Z'
    comment: >-
      Grooming check: The implementation plan is defined in the description
      below.  Proposed Metadata: Priority: Low, Effort: S, Tags: docs, ui. Does
      this plan and metadata look correct? Please confirm or adjust.
    id: c-1778131426196-flux-65.md
  - type: comment
    user: Guy
    date: '2026-05-07T05:57:49.673Z'
    comment: ok metadata but pls proper groom the ticket!!
    id: c-2026-05-07t05-57-49-673z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T05:57:49.673Z'
    comment: Response submitted
title: docs improvement
status: Todo
createdBy: Guy
updatedBy: Guy
order: 11
---
## Summary

Improve the docs screen layout by separating scroll contexts and condensing
the top-right section to maximize usable content space.

## Requirements

### 1. Independent scroll containers
- Docs sidebar hierarchy navigation and main doc content should scroll independently
- Scrolling the doc view should not affect the sidebar scroll position
- Scrolling the sidebar should not affect the doc view scroll position

### 2. Compact top-right section
- Reduce padding and margins in the top-right section of the docs view
- Keep all controls accessible but use space more efficiently
- Layout should still work well at different viewport sizes

## Acceptance Criteria

- [ ] Docs sidebar navigation scrolls independently from the main doc content
- [ ] Scrolling in the doc view does not affect sidebar scroll position
- [ ] Top right section has reduced padding/margins for a more compact layout
- [ ] Layout still works well at different viewport sizes

## Likely Affected Areas

- `portal/src/components/DocsScreen.tsx`
- `portal/src/components/DocsScreen.css` or equivalent styles

## Original Request
1. separate scrolling for the hierarchy navigation and the doc itself, scrolling in the doc shouldnt take us away from the left side navigation position
2. top section on right side is too bulky, we should condense it to be more space aware
![image](assets/FLUX-65/image.png)
