---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: '6158e72'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-12T04:21:48.404Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T04:21:55.935Z'
    comment: Launched Claude Code session (bb5f54a3).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-12T04:23:43.412Z'
  - type: comment
    user: Agent
    date: '2026-05-12T04:23:43.412Z'
    comment: >-
      Root cause: after createTask() succeeds, the returned task was discarded.
      modalTask.id remained null, so isDirty stayed true and every subsequent
      Save call hit the POST /api/tasks branch again, creating duplicate
      tickets.


      Fix: one-line change in portal/src/components/TaskModal.tsx — capture the
      returned Task from createTask and call setModalTask(createdTask). This
      causes useTaskForm to sync its baseline to the saved state, clearing
      isDirty.
    id: c-2026-05-12t04-25-02-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-12T04:23:43.412Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:23:48.779Z'
    comment: >-
      The fix is applied and the ticket is now In Progress. Here's the summary:


      **Root cause:** `handleSave` in `TaskModal.tsx` discarded the return value
      of `createTask()`. With `modalTask.id` still null, `isDirty` stayed true
      and every Save re-hit the POST branch, creating a new ticket each time.


      **Fix (1 line, `portal/src/components/TaskModal.tsx:441`):** Capture the
      returned task and call `setModalTask(createdTask)`. This syncs
      `useTaskForm`'s baseline to the saved state, clearing `isDirty` after the
      first save.


      Ready for `finish FLUX-217` when you'd like to commit.
  - type: activity
    user: Agent
    date: '2026-05-12T04:23:48.781Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T04:27:43.906Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T04:27:58.945Z'
  - type: activity
    user: Agent
    date: '2026-05-12T04:27:58.987Z'
    comment: Launched Claude Code session (9b1e2aeb).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T04:28:27.099Z'
  - type: comment
    user: Agent
    comment: >-
      Code review (Linus mode):


      The fix is correct. Two lines. No ceremony. You found the actual bug —
      createTask() returned the new task with its ID, you were throwing it away,
      so isDirty never cleared and every Save hit the POST branch again. The fix
      captures that return value and calls setModalTask(). Done.


      Symmetry with the update path (line 439) is preserved. No new
      abstractions, no dead code, no pointless comments.


      This is what a bug fix should look like. Passes.
    date: '2026-05-12T04:28:27.099Z'
    id: c-2026-05-12t04-28-27-099z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:28:35.649Z'
    comment: >-
      Ticket is now **Ready**.


      Review verdict: **Passes.** The fix is a textbook two-liner — capture the
      return value from `createTask()`, call `setModalTask(createdTask)`. Root
      cause was correctly identified (discarded return value → stale `id` →
      `isDirty` never cleared → duplicate POSTs on every Save). The update path
      already did this correctly on line 439; the create path just didn't. Fix
      matches the existing pattern exactly. Nothing to complain about.
  - type: activity
    user: Agent
    date: '2026-05-12T04:28:35.658Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T04:28:43.150Z'
    comment: Launched Claude Code session (8734f08f).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-12T04:29:47.764Z'
  - type: activity
    user: Agent
    date: '2026-05-12T04:29:47.764Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T04:29:53.740Z'
    comment: >-
      FLUX-217 is now **Done**. Here's the summary:


      - **Commit:** `6158e72` — "Fix new ticket save creating duplicate tickets
      on every save"

      - **Fix:** Two lines in `portal/src/components/TaskModal.tsx` — captured
      the return value from `createTask()` and called
      `setModalTask(createdTask)`, so the modal tracks the new ticket's ID after
      the first save, clearing `isDirty` and routing all subsequent saves to the
      PUT (update) path instead of POST.

      - **Ticket:** Closed with `implementationLink: 6158e72`, status moved to
      Done.
  - type: activity
    user: Agent
    date: '2026-05-12T04:29:53.745Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-12T07:32:59.677Z'
title: 'bug when creating new ticket, save doesnt work proerly after inputting title'
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 969992
  outputTokens: 8068
  costUSD: 0.645074
  costIsEstimated: false
  cacheReadTokens: 903651
  cacheCreationTokens: 66297
---
still thinks the ticket is dirty, every click of save creates a new ticket...
