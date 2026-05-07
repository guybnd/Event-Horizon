---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T02:09:21.786Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-07T03:01:48.813Z'
    comment: >-
      I want a setting in the settings page if clicking cards on board will open
      them as full view or popup view
    id: c-2026-05-07t03-01-48-813z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T03:01:48.813Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T13:08:18.8534935+10:00'
    comment: >-
      Plan: add a config-backed board card open-mode setting in Settings,
      default it to full view to match the ticket direction, then route board
      card clicks through that setting and update the interaction docs.
    id: c-2026-05-07t13-08-18-8534935-10-00
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-07T13:08:18.8534935+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T13:10:47.4447652+10:00'
    comment: >-
      Added a config-backed board card click setting, exposed it in Settings,
      defaulted the shipped behavior to full view, and routed board card
      interactions through that setting. Updated the interaction docs to match.
      Validated with `npm.cmd run build -w portal`, a live portal check that
      showed the new `Board Card Click Behavior` control on `/settings`, and a
      board card click that opened
      `http://localhost:5173/board?ticket=FLUX-53&view=full`. Engine typecheck
      remains blocked by the package's pre-existing
      CommonJS/verbatimModuleSyntax mismatch, not by this change. Commit is
      deferred because the current worktree already contains unrelated shared
      changes, so a focused FLUX-54 commit is not cleanly isolated yet.
    id: c-2026-05-07t13-10-47-4447652-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T13:10:47.4447652+10:00'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-07T03:18:03.527Z'
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-05-07T03:18:16.787Z'
title: 'add setting, click card default to fullview'
status: Ready
createdBy: Guy
updatedBy: Guy
order: 0
---
