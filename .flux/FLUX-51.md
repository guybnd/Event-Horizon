---
id: FLUX-51
title: Unify markdown description editor across ticket surfaces
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: unassigned
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

- [ ] Popup, full-view, and backlog ticket descriptions render markdown by default
- [ ] Clicking a description enters edit mode consistently across the ticket surfaces
- [ ] The shared editor/view code is centralized instead of duplicated per surface
- [ ] Markdown still round-trips cleanly to the ticket files on disk
- [ ] Existing docs-editor behavior remains intact or is refactored safely onto the shared base without regression

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
