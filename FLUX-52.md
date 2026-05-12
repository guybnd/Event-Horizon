---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: d6d6e60
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:45:19.115Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T01:45:56.569Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-07T01:56:00.000Z'
    comment: >-
      Plan: keep the docs editor toolbar visible as a sticky page-following bar,
      but reduce misleading active states by only showing pressed formatting
      controls when the editor has an active text selection instead of showing
      stale context while the editor is blurred or the selection is collapsed.
    id: c-2026-05-07t01-56-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T01:56:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T12:13:27.3068907+10:00'
    comment: >-
      Completed the docs editor toolbar pass in `d6d6e60`. The formatting bar
      now stays sticky while long docs scroll, and formatting controls only
      render as active when the editor has a live text selection instead of
      showing stale pressed states. Validated with `npm.cmd run build -w
      portal`, a live browser check on `/docs`, and live docs API confirmation
      for the updated Docs Workspace page.
    id: c-2026-05-07t12-13-27-3068907-10-00-flux-52
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T12:13:27.3068907+10:00'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.960Z'
title: fix\improve edit bar in docs
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.960Z'
releaseDocPath: release-notes/v0.1.0
---
the top bar with the editing stuff (header, bold e tc.) should follow the page so if user scrolls down its still visible. 
it also need to fix its context for example even if im not marking any text it could show some 'buttons' as pressed, like list or bold or link but its not actually since im not selecting any text...
alternatively we should have maybe a mode where this bar just appears if im marking some text? what do you think? whats the best approach usually?
