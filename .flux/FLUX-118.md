---
id: FLUX-118
title: Add settings to comment tooltip box
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - ux
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T04:15:12.827Z'
    comment: Created ticket.
---

## Summary
The comment tooltip box could benefit from user-customizable settings such as font size, box dimensions, or an click-to-expand feature to improve readability.

## Requirements

### 1. Design & Implement Tooltip Customization
- Evaluate the best UX for interacting with large comments in tooltips.
- Add settings (either globally in Settings or locally on the tooltip) to adjust font size and tooltip dimensions.
- Alternatively, implement a "click to expand" feature that opens the tooltip content into a larger modal or pane.

## Acceptance Criteria
- [ ] Users can read long comments comfortably without awkward scrolling or tiny text.
- [ ] Any added settings are saved and persisted.

## Likely Affected Areas
- Tooltip component for comments.
- Settings UI.

## Notes
- We should probably prefer a "click to expand" or auto-sizing approach before adding too many manual settings.

## Original Request
maybe we want bigger font, bigger box, click to expand, whatever. need to think of whats nice ui ux for this
