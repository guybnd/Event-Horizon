---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T02:07:17.009Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      Groomed this into a concrete first slice. The existing config model
      already supports `StatusDef.color`, so the remaining work is to expose
      status color editing in Settings, seed sensible defaults for the shipped
      statuses, and render those colors consistently anywhere a status name is
      shown. Moving to `Todo`.
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-53
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
id: FLUX-53
title: colors for statuses
status: Todo
createdBy: Guy
updatedBy: Agent
---
## Summary

Make ticket statuses color-configurable in Settings and show those colors
consistently anywhere a status label is rendered.

## Requirements

### 1. Configure status colors in Settings
- Extend the status editing UI so both board columns and hidden statuses can
  pick a color, similar to tag editing
- Persist the selected color on each `StatusDef`
- Preserve colors through status renames, reordering, and workflow-status
  restore actions

### 2. Seed useful defaults
- Use a sensible default palette for the shipped statuses: `Done` green,
  `In Progress` blue, `Require Input` and `Ready` amber, `Grooming` orange,
  `Todo` light blue, and `Backlog` gray
- Fall back gracefully when a custom status has no explicit color yet

### 3. Render status colors across the product
- Show a colored status badge or chip anywhere the status name is surfaced,
  including ticket search results, ticket modal summaries, and settings
  previews
- Keep status colors purely visual so workflow logic still keys off the status
  name, not the color

## Acceptance Criteria

- [ ] Settings lets the user assign colors to board and hidden statuses
- [ ] Status colors persist in config and survive rename or reorder operations
- [ ] Shipped default statuses have useful default colors
- [ ] Status colors appear anywhere the UI currently renders a status name
- [ ] Workflow behavior continues to use status names, not color values

## Likely Affected Areas

- `portal/src/components/Settings.tsx`
- `portal/src/components/Header.tsx`
- `portal/src/components/TaskModal.tsx`
- `portal/src/types.ts`
- `.flux/config.json`

color should be shown in search and any screen that might show a ticket's status name
