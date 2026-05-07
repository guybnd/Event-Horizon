---
title: Unify markdown description editor across ticket surfaces
status: In Progress
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:32:36.327Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      This needs one scope choice before it is ready for `Todo`. Should the
      first slice unify only the ticket-description surfaces (popup, full view,
      backlog-related ticket editing), or do you want the docs editor itself
      refactored into the same shared component in this initial ticket?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-51
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:26:13.694Z'
    comment: >-
      i feel like all description surfaces should be the same unified component
      that maybe can simply operate in different modes but shared component
      code. LMK if this is not a correct approach
    id: c-2026-05-07t03-26-13-694z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:26:13.694Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Groomed this into the canonical shared-editor ticket. FLUX-9 and FLUX-30
      are folded into this scope so the rendered markdown view, click-to-edit
      behavior, and shared editor chrome ship from one implementation slice.
    id: c-2026-05-07t03-53-39-4816199z-flux-51
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
  - type: comment
    user: Guy
    date: '2026-05-07T04:49:32.788Z'
    comment: >-
      since ticket created, add options for inline images and stuff like that,
      need to have this supported as well properly across
    id: c-2026-05-07t04-49-32-788z
  - type: comment
    user: Agent
    date: '2026-05-07T05:20:00.000Z'
    comment: >-
      Starting implementation from the shared ticket-description surface.
      Plan: extract one reusable markdown preview/editor component that keeps
      the current image attachment flow, switch popup/full-view/backlog to that
      shared surface, then validate with a focused portal build and live UI
      checks.
    id: c-2026-05-07t05-20-00-000z-flux-51
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T05:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T05:35:00.000Z'
    comment: >-
      Implemented the shared ticket-description surface across popup,
      full-view, and backlog detail. Ticket descriptions now default to rendered
      markdown everywhere, clicking the description enters the shared editor,
      and the same toolbar plus image-attachment flow is reused across those
      surfaces. Backlog detail now uses the same editor shell with local save
      and cancel actions, while popup and full-view keep the existing ticket
      draft/save flow. The docs editor stays intact; this slice kept the ticket
      description path on the existing markdown renderer/editor model so image
      and markdown round-tripping stay stable.

      Validation: `npm.cmd run build -w portal` after the final backlog fix,
      live full-view and popup checks confirming rendered markdown by default
      and click-to-edit behavior, a live backlog check confirming the shared
      editor plus local save/cancel actions, and a live `/api/docs` check
      confirming the refreshed `workflow/ticket-interactions` page still parses.
    id: c-2026-05-07t05-35-00-000z-flux-51
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T05:35:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T05:42:00.000Z'
    comment: >-
      User review redirected this back into implementation. The current shared
      ticket-description surface still switches into raw markdown editing,
      which does not match the docs WYSIWYG experience. Next slice: replace the
      task-surface raw textarea with the docs-style formatted editor model and
      return to rendered view on outside click instead of leaving the ticket in
      source-markdown mode.
    id: c-2026-05-07t05-42-00-000z-flux-51
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-07T05:42:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T15:30:40.8520942+10:00'
    comment: >-
      Completed the docs-style shared description editor slice. Popup,
      full-view, and backlog detail now all enter a formatted TipTap editor
      instead of a raw markdown textarea, clicking outside the editor returns
      the surface to rendered markdown preview, and task asset links/images now
      resolve inside both preview and edit modes. Backlog local save/cancel and
      popup/full unsaved-state handling were tightened so opening and closing
      the editor without edits does not create false dirty state.

      Validation: `npm.cmd run build -w portal`; live preview checks on
      `http://127.0.0.1:4173/board?ticket=FLUX-59&view=full`,
      `http://127.0.0.1:4173/board?ticket=FLUX-51&view=popup`, and
      `http://127.0.0.1:4173/backlog` confirming formatted edit mode, zero
      ticket-description source textareas, and outside-click return to preview;
      plus a localhost dev-server sanity check confirming the shared editor now
      loads without the prior Vite import-analysis overlay.
    id: c-2026-05-07t15-30-40-8520942-10-00-flux-51
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T15:30:40.8520942+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T15:34:38.5470320+10:00'
    comment: >-
      User review reopened this ticket. The shared ticket-description surface
      still differs from Docs in one important way: it swaps from a rendered
      markdown preview DOM into a separate editor DOM. That reset breaks scroll
      continuity while editing and prevents click-to-edit from placing the
      caret at the clicked spot. Next slice: keep one editor surface mounted in
      the same scroll container, toggle read-only vs editable behavior in
      place, and validate the popup, full-view, and backlog flows again.
    id: c-2026-05-07t15-34-38-5470320-10-00-flux-51
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-07T15:34:38.5470320+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T15:54:41.3067028+10:00'
    comment: >-
      Reverted the last broken scroll-target experiment that moved overflow onto
      the inner editor node, and tightened the read-only interaction model so
      the ticket description shell owns scroll and click-to-edit entry while
      the same editor DOM stays mounted underneath. Validation so far:
      `npm.cmd run build -w portal` passes and the popup shell again reports a
      live scroll range after the revert. Remaining blocker: after reloading
      fresh localhost board pages, the targeted ticket modal no longer reopens
      in automation, so full popup/full-view runtime confirmation is still
      pending before this can move out of `In Progress`.
    id: c-2026-05-07t15-54-41-3067028-10-00-flux-51
---
## Summary

Extract the docs markdown editor/view stack into a shared description surface
used across ticket popup, full view, and backlog detail screens so every ticket
description renders markdown consistently and enters edit mode by clicking the
description content.

## Requirements

### 1. Build one shared description surface
- Create a shared component or shared editor primitives for rendered view, edit mode, toolbar, and layout chrome
- Support mode variants for popup, full-view, backlog detail, and docs-adjacent usage where needed
- Avoid keeping separate markdown rendering and editing logic in each surface

### 2. Make rendered markdown the default everywhere
- Ticket descriptions should render formatted markdown by default in popup, full view, and backlog detail
- Clicking the description content should enter edit mode; a dedicated edit button is optional, not required
- Shared rendering should cover headings, emphasis, lists, links, code blocks, tables, and other markdown features already supported in the product

### 3. Reuse the richer editing experience
- Base the ticket editing experience on the docs editor stack or extracted primitives from it
- Keep markdown as the persisted on-disk format even if the editor presents a richer surface
- Reuse the same follower edit bar / toolbar behavior where it makes sense instead of reintroducing the raw textarea flow

### 4. Roll out the component across the ticket surfaces
- Popup ticket modal
- Full ticket view
- Backlog detail description panel
- Any shared markdown-preview plumbing needed for ticket cross-links or future enhancements

## Acceptance Criteria

- [x] Popup, full-view, and backlog ticket descriptions render markdown by default
- [x] Clicking a description enters edit mode consistently across the ticket surfaces
- [x] The shared editor/view code is centralized instead of duplicated per surface
- [x] Markdown still round-trips cleanly to the ticket files on disk
- [x] Existing docs-editor behavior remains intact or is refactored safely onto the shared base without regression

## Likely Affected Areas

- `portal/src/components/TaskModal.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/components/DocsScreen.tsx`
- New shared markdown description component(s) under `portal/src/components/`
- `portal/package.json` if editor or markdown dependencies change

## Dependencies

- Consolidates FLUX-9 and FLUX-30 into one implementation slice
- Related to FLUX-5 for docs/editor behavior consistency

## Notes

- The docs editor is the reference implementation today, but the first implementation can extract shared primitives incrementally if a full one-shot replacement is too risky
