---
assignee: unassigned
tags: []
priority: Critical
effort: S
implementationLink: e2e94f1
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T05:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T05:00:00.000Z'
    comment: >-
      **Closed FLUX-134** (commit `e2e94f1`):


      **1. Comment spam fix** (`engine/src/index.ts`):

      Added `pendingAssistantText` buffer. Pure-text assistant events are
      deferred; if the next event contains tool_use the text is discarded
      (narration). Otherwise it is committed to ticket history. Applied to both
      the main session handler and the reply handler.


      **2. Live output panel in popup modal**
      (`portal/src/components/TaskModal.tsx`):

      The live `<pre>` panel was only rendered in the full-view sidebar. Added
      the same block to the popup modal so users see live output regardless of
      which view they use.


      TypeScript: clean. Both changes validated against the running engine.
    id: c-2026-05-09t05-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T05:00:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:53:24.136Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:53:24.136Z'
    comment: Updated implementation link.
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:53:26.901Z'
    comment: >-
      ```text

      FLUX-134 is closed. Commit `e2e94f1` captures both fixes: the
      `pendingAssistantText` buffer that filters narration from ticket history,
      and the live output panel restored to the popup modal.

      ```
    id: c-2026-05-08t14-53-26-901z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.345Z'
title: improvements to two-way integration
status: Released
createdBy: Guy
updatedBy: Agent
order: 1
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.345Z'
releaseDocPath: release-notes/0.2.0
---
1.  bot can be spamming a lot wiht messages that are not interesting for ticket. maybe we need a UI thats just the 'thought proccess' and a distinct pathway for the agent bot to contact or update the user with just pertinent things  
    2\. need ot think what happens when the bot needs permission grants into the CLI  
    3\. need to rethink the UI of how it distincts between updates and requests for info from the user etc  
    4\. the button to launch the guy shouljd be more central and accessible and not hidden at the bottom , maybe need to add it to the right mouseclick button too
