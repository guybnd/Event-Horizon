---
title: 'Customize UI: Fix fullscreen editor & send button'
status: In Progress
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - bug
history:
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-06T16:51:00+10:00'
  - type: comment
    user: Agent
    date: '2026-05-06T16:51:00+10:00'
    comment: >-
      I am planning the implementation for the Markdown editor, wide-mode
      toggle, and comment send button!
  - type: comment
    user: Guy
    date: '2026-05-06T06:58:36.188Z'
    comment: >-
      1. pressing send does not do anything until i close and reopen the window


      2. fullscreen editor looks weird, it opens a big window but the actual
      text field is a small part of it and unscalable
  - type: comment
    user: Agent
    date: '2026-05-06T07:27:00.000Z'
    comment: >-
      Fleshing out this ticket with specific bugs and acceptance criteria based on
      Guy's feedback.
---
## Summary

Fix the two reported bugs with the task modal UI and polish the description editing experience.

## Bugs to Fix

### 1. Send button does not work until modal is reopened
- **Current behavior:** Pressing "Send" on a comment appears to do nothing; the comment only appears after closing and reopening the modal.
- **Root cause:** `sendCommentDirectly()` calls `handleSave([commentEntry])` which updates the task on the server and calls `setModalTask(updatedTask)`, but the local `newComment` state isn't cleared until after the save, and the history displayed comes from `modalTask.history` which may not update synchronously.
- **Fix:** After successful send, ensure `setModalTask` fires with the updated task including the new comment in its history, and clear `newComment`. Verify the comment appears immediately in the activity feed without reopening.

### 2. Fullscreen editor layout is broken
- **Current behavior:** Fullscreen mode opens a large container, but the textarea is a small, unscalable portion of it.
- **Root cause:** The `isFullscreen` CSS path wraps the editor in a `fixed inset-0` div, but the textarea inside uses `flex-1` without the parent having proper flex sizing. The `max-w-5xl mx-auto` constraint also limits width unnecessarily.
- **Fix:** Make the textarea fill the full available height/width of the fullscreen container. Remove or adjust the `max-w-5xl` constraint. Ensure the toolbar stays pinned at top and textarea fills remaining space.

## Acceptance Criteria

- [ ] Clicking "Send" on a comment immediately shows it in the activity feed without needing to close/reopen the modal
- [ ] Fullscreen editor fills the entire screen with the textarea taking up all available space below the toolbar
- [ ] Textarea in fullscreen is resizable or auto-fills height
- [ ] Exiting fullscreen returns to the normal modal layout cleanly
- [ ] Wide mode still works correctly after fixes

## Files to Modify

- `portal/src/components/TaskModal.tsx` — Fix `sendCommentDirectly`, fix fullscreen CSS layout

