---
title: add sort and fitlers to kanban and backlog view
status: Todo
priority: None
createdBy: Guy
updatedBy: Guy
assignee: Guy
tags: []
history:
  - type: comment
    user: Agent
    date: '2026-05-06T19:20:00.000Z'
    comment: >-
      Re-groomed with a narrower first version. This still needs one product
      decision on whether sort/filter state should be global, per page, or URL
      encoded.
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T19:35:00.000Z'
    comment: >-
      Requesting product choice in-ticket: should sort/filter state stay local
      to the current session, or be encoded in the URL so filtered views are
      shareable and reload-safe? URL state is more capable but adds scope.
  - type: comment
    user: Guy
    date: '2026-05-06T09:28:20.476Z'
    comment: url
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T09:28:20.476Z'
    comment: Response submitted
---
## Groomed Scope

Add first-pass sort and filter controls for the board and backlog views so users can narrow large ticket sets quickly.

## Proposed First Version

### Sort options
- Priority
- Recently updated
- Assignee

### Filter options
- Assignee
- Priority
- Tag

## Acceptance Criteria

- [ ] Board view supports one active sort option and multiple filters
- [ ] Backlog view supports the same sort and filter set
- [ ] Clearing filters returns to the default view

## User Input Needed

- Should sort/filter state live only in current session state, or do you want it reflected in the URL so filtered views are shareable?

## Files Likely Affected

- `portal/src/components/Board.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/AppContext.tsx`
