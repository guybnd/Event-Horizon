---
assignee: unassigned
tags:
  - ui
  - feature
priority: Medium
effort: M
implementationLink: '881ac3e0cc4810ad72c2efc79285aa475bdbeef8'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T04:27:45.319Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T04:29:28.559Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-07T05:23:46.190Z'
    comment: >-
      Grooming check: The implementation plan is defined in the description
      below.  Proposed Metadata: Priority: Medium, Effort: M, Tags: ui,
      enhancement. Does this plan and metadata look correct? Please confirm or
      adjust.
    id: c-1778131426195-flux-63.md
  - type: comment
    user: Guy
    date: '2026-05-07T05:49:11.174Z'
    comment: >-
      accept the metadata but please make a more better ticket for this this is
      childs grooming
    id: c-2026-05-07t05-49-11-174z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T05:49:11.174Z'
    comment: Response submitted
title: card full view improvements
status: Done
createdBy: Guy
updatedBy: Guy
order: 14
---
## Summary

Redesign the full ticket view layout so the description uses available screen
space, and rework the comment section with a smart sticky/floating input and
intelligent auto-scroll behavior.

## Requirements

### 1. Description takes full available space
- Description section should expand to use the full viewport width and height when the content warrants it
- No artificial max-width or height constraints that waste screen real estate
- Description should gracefully shrink when there is minimal content

### 2. Floating/sticky comment input
- Comment input should become sticky/floating when scrolling through comments
- When scrolling into the comments section, the input anchors to the top of the viewport
- Input starts compact and expands as the user types more text
- Input should only be visible when actively engaging with comments

### 3. Smart comment display and auto-scroll
- Default view anchors the latest comment to the bottom of the page
- Comment box is hidden by default; a Reply button reveals it
- Show comment box automatically when the user scrolls into the comment section or when the description is small enough to leave room
- Avoid forcing the user to scroll past empty space to reach comments

## Acceptance Criteria

- [ ] Description section uses full available screen space dynamically
- [ ] Comment input becomes sticky/floating when scrolling through comments
- [ ] Comment input starts compact and expands with text content
- [ ] Latest comment is anchored at bottom in default view
- [ ] Reply button opens the comment input
- [ ] Comment box auto-shows when scrolling into comment area

## Likely Affected Areas

- `portal/src/components/TaskModal.tsx` (full-view mode)
- `portal/src/index.css` or component-level styles

## Original Request
description section should take up entire screen if needed.
comment box should be kinda of floating as in, once it comes into view, it stays anchored on top as i scroll through the comments. it can be smaller than it currently is unless it needs to expand with amount of text
we should probably anchor only the latest comment to the bottom of page in default view without showing comment box. we can hit reply button to open comment box
show comment box only when scrolling down into the comment section or if description box is small enough




