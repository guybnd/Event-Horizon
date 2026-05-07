---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: 7dbd52f
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
  - type: comment
    user: Agent
    date: '2026-05-07T13:11:54.1319530+10:00'
    comment: >-
      Plan: add shared status-color defaults and a reusable status badge, expose
      status color editing for board and hidden statuses in Settings, then
      replace plain status text in search and ticket views with the new colored
      badges.
    id: c-2026-05-07t13-11-54-1319530-10-00
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T13:11:54.1319530+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T13:18:19.3521704+10:00'
    comment: >-
      Added configurable status colors in Settings for both board and hidden
      statuses, seeded the shipped workflow statuses with a default palette, and
      introduced shared status badge rendering so the colors show up in board
      lanes, search results, ticket headers, activity history, and other ticket
      surfaces. Updated ticket interaction docs to describe the new behavior.
      Validated with `npm.cmd run build -w portal`, a live config check from
      `http://localhost:3001/api/config`, engine task parsing that still reports
      `FLUX-53` and `FLUX-54` correctly, a live Settings view showing colored
      status chips, and a full ticket view showing the colored `In Progress`
      badge. Commit is deferred because the current worktree still contains
      unrelated shared-file changes, so a focused commit is not cleanly isolated
      yet.
    id: c-2026-05-07t13-18-19-3521704-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T13:18:19.3521704+10:00'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-07T03:19:44.052Z'
  - type: comment
    user: Guy
    date: '2026-05-07T03:20:24.460Z'
    comment: >-
      settings page looks broken, need a cleaner way to sort this and color
      select. maybe just show a popup when pressing on the title color of the
      status?
    id: c-2026-05-07t03-20-24-460z
  - type: comment
    user: Agent
    date: '2026-05-07T13:29:51.8493553+10:00'
    comment: >-
      Follow-up polish for the in-progress settings redesign: make the status
      picker swatches use the same saturated visual treatment as the priority
      picker, and align the Global Tags swatch palette with the saved tag chip
      colors so the picker no longer looks muted or misleading.
    id: c-2026-05-07t13-29-51-8493553-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T13:44:00.8522304+10:00'
    comment: >-
      Finalized in mixed commit `7dbd52f` per user instruction to clear the
      board. The commit ships the status-color defaults, the shared status badge
      rendering, and the settings follow-up that turns status color selection
      into a cleaner badge-triggered popup flow. Validated with `npm.cmd run
      build -w portal` before commit.
    id: c-2026-05-07t13-44-00-8522304-10-00-flux-53
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T13:44:00.8522304+10:00'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.961Z'
title: colors for statuses
status: Released
createdBy: Guy
updatedBy: Agent
order: 0
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.961Z'
releaseDocPath: release-notes/v0.1.0
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

- [x] Settings lets the user assign colors to board and hidden statuses
- [x] Status colors persist in config and survive rename or reorder operations
- [x] Shipped default statuses have useful default colors
- [x] Status colors appear anywhere the UI currently renders a status name
- [x] Workflow behavior continues to use status names, not color values

## Likely Affected Areas

- `portal/src/components/Settings.tsx`
- `portal/src/components/Header.tsx`
- `portal/src/components/TaskModal.tsx`
- `portal/src/types.ts`
- `.flux/config.json`

color should be shown in search and any screen that might show a ticket's status name
