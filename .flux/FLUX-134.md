---
assignee: unassigned
tags: []
priority: Critical
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T01:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T01:00:00.000Z'
    comment: >-
      Implementation complete for all three feedback items:


      **1. ContextMenu "Launch Agent" fix**
      (`portal/src/components/ContextMenu.tsx`):

      - "Launch Agent" now calls `startTaskCliSession` directly (with
      `skipPermissions: true`) then opens the ticket view, rather than just
      opening the ticket view.


      **2. Agent Session in top bar** (`portal/src/components/TaskModal.tsx`):

      - Full view header now includes a persistent Agent Session widget between
      Save and Close.

      - When session is idle: shows a "Launch Agent" button.

      - When session is active: shows an animated status pill (green=running,
      amber=waiting-input) and a Stop button.


      **3. Return + Launch Agent button**
      (`portal/src/components/TaskModal.tsx`):

      - The rejection textarea now shows two action buttons: "Return to work"
      (return only) and "Return + Launch Agent" (return and immediately start a
      new CLI session).


      **Also fixed**: `portal/src/api.ts` `startTaskCliSession` was missing the
      `skipPermissions` parameter that the previous session added to the call
      sites but not the function signature.


      TypeScript: clean.
    id: c-2026-05-09t01-00-00-000z
  - type: status_change
    from: Grooming
    to: Ready
    user: Agent
    date: '2026-05-09T01:00:01.000Z'
  - type: status_change
    from: Grooming
    to: Ready
    user: Agent
    date: '2026-05-08T14:13:35.034Z'
  - type: comment
    user: Guy
    date: '2026-05-08T14:14:56.469Z'
    comment: >-
      this ticket does not at all address the comment spam. i believe it did but
      the work was undone somehow?
    replyTo: c-2026-05-09t01-00-00-000z
    id: c-2026-05-08t14-14-56-469z
  - type: status_change
    from: Ready
    to: Grooming
    user: Guy
    date: '2026-05-08T14:14:56.469Z'
    comment: Returned to work
  - type: status_change
    from: Ready
    to: Grooming
    user: Guy
    date: '2026-05-08T14:14:56.475Z'
  - type: comment
    user: Agent
    date: '2026-05-09T02:00:00.000Z'
    comment: >-
      **Fixed comment spam** (`engine/src/index.ts`):


      Root cause: the engine was saving ALL `assistant` text blocks to ticket
      history, including narration that precedes tool calls ("Let me read the
      ticket...", "Now I understand...", etc.).


      Fix: when an `assistant` event contains any `tool_use` blocks alongside
      text blocks, the text is action narration and is now treated as ephemeral
      (live panel only). Only pure-text assistant messages — those with no
      tool_use in the same content array — get saved to ticket history.


      Applied to both the main session stdout handler and the reply handler.
      This matches the intended contract: only user-facing assistant messages
      (actual updates, summaries, questions) appear in ticket history.
    id: c-2026-05-09t02-00-00-000z
  - type: status_change
    from: Grooming
    to: Ready
    user: Agent
    date: '2026-05-09T02:00:01.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T14:23:41.855Z'
    comment: >-
      but wheres the live panel? i believe we started to work on it and it
      diissapeared.
    replyTo: c-2026-05-09t02-00-00-000z
    id: c-2026-05-08t14-23-41-855z
  - type: status_change
    from: Ready
    to: Grooming
    user: Guy
    date: '2026-05-08T14:23:41.855Z'
    comment: Returned to work
  - type: comment
    user: Agent
    date: '2026-05-09T04:00:00.000Z'
    comment: >-
      **Fixed both issues** (`engine/src/index.ts`,
      `portal/src/components/TaskModal.tsx`):


      **1. Comment spam — root cause corrected:**

      The previous fix checked whether tool_use appeared in the same content
      array as the text. But the Claude CLI `--verbose stream-json` format sends
      text and tool_use in *separate* assistant events, so the check never
      fired.


      New approach: `pendingAssistantText` buffer on the session record. When a
      pure-text assistant event arrives, its text is held in the buffer rather
      than saved immediately. The next event determines fate:

      - Next event has `tool_use` → discard pending text (it was narration) -
      Next event is anything else (non-tool turn, result, end of session) →
      commit pending text to history

      This ensures only deliberate user-facing messages appear in ticket
      history.


      **2. Live panel visible in popup modal:**

      The live output panel was only rendered in the full-view sidebar
      (`detailsPanel`). It was never in the popup modal, so users in popup mode
      never saw it.

      Added the same live output `<pre>` block to the popup modal, appearing
      between the subtasks section and the activity/comments section whenever
      `cliSession?.liveOutput` is truthy.


      TypeScript: clean.
    id: c-2026-05-09t04-00-00-000z
  - type: status_change
    from: Grooming
    to: Ready
    user: Agent
    date: '2026-05-09T04:00:01.000Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:52:45.651Z'
    comment: Launched Claude Code session (052ef192).
title: improvements to two-way integration
status: Ready
createdBy: Guy
updatedBy: Agent
order: 1
---
1.  bot can be spamming a lot wiht messages that are not interesting for ticket. maybe we need a UI thats just the 'thought proccess' and a distinct pathway for the agent bot to contact or update the user with just pertinent things  
    2\. need ot think what happens when the bot needs permission grants into the CLI  
    3\. need to rethink the UI of how it distincts between updates and requests for info from the user etc  
    4\. the button to launch the guy shouljd be more central and accessible and not hidden at the bottom , maybe need to add it to the right mouseclick button too
