---
title: Attach images to a ticket
status: Todo
createdBy: Guy
updatedBy: Guy
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
---
## Summary

Allow users to attach images to tickets by pasting from the clipboard or by
dragging and dropping files into the ticket description surface, then show those
images inline in the ticket content.

## Proposed First Slice

- Paste an image with `Ctrl+V` or drag/drop it into a ticket description surface
- Persist the image to a local file that the repository can track
- Insert a markdown image link into the ticket body automatically
- Render the linked image inline anywhere ticket markdown is displayed

## Open Question

Should pasted and dropped images be stored as repo-managed files under a path
like `.flux/assets/<ticket-id>/...` with relative markdown links inserted into
the ticket body?

## Why This Needs Input

- The storage location determines git behavior, portability, cleanup rules, and how the engine resolves the files later
- Once that storage contract is chosen, the rest of the ticket can move back to `Grooming` or `Todo` quickly
