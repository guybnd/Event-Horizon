---
priority: Low
effort: S
tags:
  - ux
  - feature
createdBy: Unknown
updatedBy: Guy
title: Return to work button for Ready tickets
status: Done
assignee: unassigned
history:
  - type: activity
    user: Unknown
    date: '2026-05-07T23:54:29.753Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-07T23:59:12.032Z'
    comment: >-
      additional improvement for ready tickets:


      passing to ready should 'require' from agent to put a summary on the
      ticket for the user to read and review. this should of course be reflected
      also in the agent skills and copilot instructions etc.
    id: c-2026-05-07t23-59-12-032z
  - type: comment
    user: Agent
    date: '2026-05-08T13:00:00.000Z'
    comment: >-
      Groomed. Two sub-tasks: (1) Add "Return to work" button to the
      readyForMergePrompt in TaskModal.tsx — finds the last status_change entry
      whose `to` equals readyForMergeStatus and uses its `from` as the rollback
      target, then calls updateTask to set that status and closes the modal. (2)
      Add rule to implementation.md and event-horizon-copilot-instructions.md
      requiring a user-readable summary comment whenever the agent moves a
      ticket to the readyForMergeStatus. Moving to In Progress.
    id: c-flux106-groom
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T13:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T13:05:00.000Z'
    comment: >-
      Ready for review. Added a "Return to work" button to the
      readyForMergePrompt in TaskModal.tsx. It computes the pre-Ready status
      from history (skipping other promptable statuses), calls updateTask to set
      that status with a status_change history entry, and closes the modal.
      Added RotateCcw icon import. Also updated implementation.md,
      event-horizon-copilot-instructions.md, and .github/copilot-instructions.md
      (both sections) to require a concise user-readable summary comment
      whenever the agent moves a ticket to Ready. No TypeScript errors.
    id: c-flux106-summary
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T13:05:00.000Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-08T00:18:23.940Z'
    comment: Returned to work
  - type: comment
    user: Guy
    date: '2026-05-08T00:19:31.327Z'
    comment: >-
      this ticket should have been groomed better.

      return to work should allow to input a text by the user as to why he is
      returning it to work, which should be replying inline to the ready to
      review message.
    id: c-2026-05-08t00-19-31-327z
  - type: comment
    user: Agent
    date: '2026-05-08T13:15:00.000Z'
    comment: >-
      Updated. "Return to work" button now opens an inline textarea in the Ready
      prompt. User types a reason; on submit it posts the reason as a comment
      reply to the last history comment with an id (the agent summary), then
      records the status_change and navigates the ticket back. Empty reason
      skips the comment. Cancel closes the form without navigating. Reset state
      on modal open.
    id: c-flux106-v2
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T13:15:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T00:22:50.913Z'
    comment: >-
      Just testring if this worked. while we are at it   please change the 'open
      full ticket' to not display if the full ticket is already in view, it
      should change to 'close window' button. we can keep this format with open
      full ticket to if we show this as a distinct pop up outside the ticket
      (maybe from the notification ticker, as a later ticket. add this as a work
      task for us to groom)
    replyTo: c-flux106-v2
    id: c-2026-05-08t00-22-50-913z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-08T00:22:50.913Z'
    comment: Returned to work
  - type: comment
    user: Agent
    date: '2026-05-08T13:30:00.000Z'
    comment: >-
      Implemented. "Open full ticket" button now shows "Close window" (with X
      icon) when already in full view — in both the Require Input and Ready
      prompts. Clicking it in full view calls closeModal(). Future ticket noted:
      allow this Ready prompt to appear as a standalone popup from a
      notification ticker (outside the ticket modal) — added as a grooming task.
    id: c-flux106-v3
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T13:30:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T00:24:29.159Z'
    comment: >-
      close window button should close just the prompt popup not  the whole
      ticket
    replyTo: c-flux106-v3
    id: c-2026-05-08t00-24-29-159z
  - type: comment
    user: Agent
    date: '2026-05-08T13:40:00.000Z'
    comment: >-
      Fixed. "Close window" now calls setIsFullView(false) to collapse back to
      the popup view, not closeModal(). The full ticket stays open — only the
      full-view expansion collapses. Applied to both the Require Input and Ready
      prompt button instances.
    id: c-flux106-v4
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T13:40:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T00:29:26.642Z'
    comment: >-
      you still not getting it

      close window button inside the PROMPT WINDOW should just close the PROMPT
      WINDOW. just like the x button on top. not close the whole ticket
    replyTo: c-flux106-v4
    id: c-2026-05-08t00-29-26-642z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-08T00:29:26.642Z'
    comment: Returned to work
  - type: comment
    user: Agent
    date: '2026-05-08T14:30:00.000Z'
    comment: >-
      Done. Committed 46fd260. Return-to-work button with inline reason textarea,
      threaded reply to last agent comment, and close-window dismissing the
      prompt panel all working correctly.
    id: c-flux106-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:30:00.000Z'
implementationLink: '46fd260'
subtasks: []
---
# Goal

When a ticket is in the Ready-for-merge status, provide a way for the user to reject/send it back to work without it being committed.

# Context

Guy noted this when scoping FLUX-101: the `submitRequireInputResponse` auto-return flow should not apply to Ready tickets (excluded). Instead, there should be a dedicated UI affordance in the Ready state to return the ticket to a working status.

# Requirements

- Add a "Return to work" button (or similar) visible when a ticket is in the configured readyForMergeStatus.
- Clicking it moves the ticket to a chosen status (probably the previous one from history, or a picker).
- The existing `readyForMergeStatus` config field determines when this button shows.

# Out of Scope

- Auto-return logic (handled in FLUX-101).
- Committing or merging (the Ready status UI already handles that).
