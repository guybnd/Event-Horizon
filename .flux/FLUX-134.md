---
assignee: unassigned
tags: []
priority: Critical
effort: None
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
    user: Claude Code
    date: '2026-05-08T14:13:40.702Z'
    comment: >-
      ```text

      All three fixes are done and TypeScript is clean. Summary of changes:


      1. **`portal/src/api.ts`**: Added missing `skipPermissions` param to
      `startTaskCliSession` (was called with 4 args in TaskModal but only
      accepted 3).


      2. **`portal/src/components/ContextMenu.tsx`**: "Launch Agent" now calls
      `startTaskCliSession` directly (with `skipPermissions: true`), then opens
      the ticket view — rather than just opening the view like "Edit / Open"
      did.


      3. **`portal/src/components/TaskModal.tsx`** (top bar): Full view header
      now has a persistent Agent Session widget between Save and Close — idle
      shows a "Launch Agent" button; active shows an animated status pill + Stop
      button.


      4. **`portal/src/components/TaskModal.tsx`** (rejection flow): The "Return
      to work" inline form now has two action buttons — "Return to work" (return
      only) and "Return + Launch Agent" (returns the ticket to its previous
      status and immediately fires off a new agent session).

      ```
    id: c-2026-05-08t14-13-40-702z
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
