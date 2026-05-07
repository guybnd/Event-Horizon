---
title: Attach images to comments with popup preview
status: Released
priority: High
createdBy: Agent
updatedBy: Guy
assignee: Agent
tags:
  - feature
  - ux
  - assets
history:
  - type: activity
    user: Agent
    date: '2026-05-07T04:46:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T04:46:00.000Z'
    comment: >-
      Split from FLUX-59 after Guy requested comment-image behavior as a
      separate immediate follow-up. Plan: reuse the existing ticket-asset upload
      path for comment and reply composers, render comment images as compact
      clickable media links instead of full inline blocks, and show a bounded
      in-page hover preview plus a larger popup image view on click.
    id: c-2026-05-07t04-46-00-000z-flux-64
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T04:46:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-07T04:45:56.263Z'
    comment: 'astestest ![image](assets/FLUX-64/image.png)'
    id: c-2026-05-07t04-45-56-263z
  - type: comment
    user: Agent
    date: '2026-05-07T05:10:00.000Z'
    comment: >-
      Implemented comment-image attachments across the threaded comment UI. The
      main comment box and inline reply composer now accept pasted or dropped
      PNG/JPG/SVG files, reuse the existing ticket-asset upload path, and insert
      relative markdown image links automatically. Comment markdown now renders
      images as compact clickable affordances with bounded hover previews and a
      larger popup preview on click, while missing assets fail gracefully.

      Validation: clean editor diagnostics on the touched files, `npm.cmd run
      build -w portal`, and a live portal check covering paste into the comment
      composer plus hover and click preview behavior.
    id: c-2026-05-07t05-10-00-000z-flux-64
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T05:10:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-07T04:58:34.895Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.978Z'
effort: M
implementationLink: ''
subtasks: []
order: 11
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.978Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary

Allow users to attach images directly in ticket comments and replies by pasting
or dragging and dropping supported image files, then render those comment
images as compact media links that preview on hover and open in a larger popup
view on click so the activity stream stays readable.

## Requirements

### 1. Capture image input in comment composers
- Support pasted or dropped image files in the main ticket comment box
- Support the same image flow in inline reply composers
- Reuse the existing supported first-version formats (`.png`, `.jpg`, `.jpeg`,
  `.svg`) and show a clear warning when unsupported files are provided

### 2. Reuse repo-managed ticket asset storage
- Save comment images under the same `.flux/assets/<ticket-id>/...` scheme used
  by description attachments
- Insert relative markdown image links into the comment or reply draft at the
  current selection
- Keep the implementation local-first and git-friendly without introducing a
  separate comment-asset model

### 3. Render comment images as compact preview affordances
- In comment history, image markdown should not expand into a full-width inline
  image block by default
- The default comment presentation should stay compact and clickable, suitable
  for an activity stream
- Hovering the affordance should show a bounded in-page preview so the user can
  inspect the image without fully opening it

### 4. Open a larger popup image view on click
- Clicking the compact comment-image affordance should open a larger popup or
  lightbox-style preview
- The popup should work for top-level comments and replies
- Missing or deleted assets should fail gracefully instead of breaking the
  comment thread UI

## Acceptance Criteria

- [ ] Users can paste or drag/drop supported image files into the main comment composer
- [ ] Users can paste or drag/drop supported image files into inline reply composers
- [ ] Comment and reply drafts receive relative markdown image links automatically
- [ ] Comment history renders image markdown as compact clickable preview affordances
- [ ] Hovering a comment image shows a bounded in-page preview
- [ ] Clicking a comment image opens a larger popup preview
- [ ] Missing or invalid comment assets fail gracefully

## Likely Affected Areas

- `portal/src/components/TaskModal.tsx`
- `portal/src/components/TaskMarkdown.tsx` or a shared ticket-markdown helper
- `portal/src/api.ts`
- `engine/src/index.ts` if the existing asset endpoint needs comment-specific reuse only

## Related Tickets

- Split from FLUX-59
- Related to FLUX-14 for the threaded comment UI surface
