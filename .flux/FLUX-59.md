---
id: FLUX-59
title: Attach images to a ticket
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
    date: '2026-05-07T03:22:20.297Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      The remaining implementation-critical choice is where the images should
      live. Recommended default: write pasted or dropped images into a
      repo-managed folder such as `.flux/assets/<ticket-id>/...` and insert a
      relative markdown link into the ticket body. Do you want that storage
      model, or a different one?
    id: c-2026-05-07t03-53-39-4816199z-flux-59
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
  - type: comment
    user: Guy
    date: '2026-05-07T03:59:15.298Z'
    comment: yeah that sounds good
    id: c-2026-05-07t03-59-15-298z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T03:59:15.298Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T04:01:46.0405379Z'
    comment: >-
      Accepted the repo-managed ticket-asset storage model and tightened this
      into a concrete implementation plan. This is now a normal `Todo` ticket.
    id: c-2026-05-07t04-01-46-0405379z-flux-59
---
## Summary

Allow users to attach images to tickets by pasting from the clipboard or by
dragging and dropping files into the ticket description surface, storing the
images under repo-managed ticket assets and inserting relative markdown links so
the result stays local-first and git-friendly.

## Requirements

### 1. Capture image input from the ticket UI
- Support `Ctrl`/`Cmd` + `V` image paste into ticket description surfaces
- Support dragging and dropping image files into the same surfaces
- Limit the first slice to supported image formats and show a clear error when the input is unsupported

### 2. Store images in repo-managed ticket assets
- Save each image under a stable path such as `.flux/assets/<ticket-id>/...`
- Generate collision-safe filenames while keeping the stored files easy to inspect in the repo
- Keep the storage scheme compatible with git, packaged runtime flows, and manual repo inspection

### 3. Insert markdown links automatically
- Insert a relative markdown image link into the ticket body at the paste or drop location
- Preserve normal markdown editing after the image is inserted
- Missing or deleted asset files should fail gracefully in rendered views

### 4. Render images anywhere ticket markdown is shown
- Inline image rendering should work in popup, full-view, and backlog ticket-description surfaces
- The implementation should align with any linked-asset rendering work from FLUX-36 where practical
- The first slice can focus on images only, not arbitrary binary attachments

## Acceptance Criteria

- [ ] Users can paste or drag/drop supported image files into a ticket description
- [ ] Images are written into a repo-managed per-ticket asset path
- [ ] The ticket body receives a relative markdown image link automatically
- [ ] Rendered ticket descriptions show the attached images inline
- [ ] Missing or invalid asset files fail gracefully

## Likely Affected Areas

- Shared ticket description/editor surfaces
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/api.ts`
- `engine/src/index.ts` or a dedicated asset-write endpoint/module

## Notes

- Related to FLUX-36, which covers previewing linked assets once they already exist in ticket content
