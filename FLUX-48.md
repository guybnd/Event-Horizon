---
assignee: unassigned
tags: []
priority: Medium
effort: None
implementationLink: 76d3314
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:09:25.634Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T12:17:48.8063190+10:00'
    comment: >-
      Plan: add visibility-aware live polling for task data so board, backlog,
      and header refresh without a page reload, then add a light update cue for
      cards that change from external file edits or status movement.
    id: c-2026-05-07t12-17-48-8063190-10-00
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T12:17:48.8063190+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T12:21:20.4312235+10:00'
    comment: >-
      Correcting the workflow state. I started implementation routing before
      getting the required grooming input on scope. Moving this ticket to
      `Require Input` and asking for the first-slice decision before any code
      changes land. Default proposal: live-sync tasks only on the board,
      backlog, header, and search via visibility-aware polling, plus a subtle
      changed-card highlight when an external file edit or status move is
      detected. Should FLUX-48 use that narrower first slice, or do you want
      docs/config sync and stronger animations included in the initial
      implementation?
    id: c-2026-05-07t12-21-20-4312235-10-00
  - type: status_change
    from: In Progress
    to: Require Input
    user: Agent
    date: '2026-05-07T12:21:20.4312235+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T12:51:17.8511006+10:00'
    comment: >-
      Scope decision: do the bigger animated dashboard first, not only silent
      task polling.
    id: c-2026-05-07t12-51-17-8511006-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T12:51:17.8511006+10:00'
    comment: >-
      Resuming implementation with the broader first slice: visibility-aware
      live polling across the shared task state, materialize and landing
      animations for new and moved tickets, lane-level arrival cues, and
      stronger prompt/live cues in the header.
    id: c-2026-05-07t12-51-17-8511006-10-00-agent
  - type: status_change
    from: Require Input
    to: In Progress
    user: Agent
    date: '2026-05-07T12:51:17.8511006+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T12:59:01.0478860+10:00'
    comment: >-
      Animation direction: newly created tickets should materialize at the top
      of their column, and tickets that move between columns should jump into
      the destination lane, land with some oomph, and bounce.
    id: c-2026-05-07t12-59-01-0478860-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T12:59:01.0478860+10:00'
    comment: >-
      Updating the implementation plan accordingly: live task polling will move
      into shared app state with per-ticket change detection, then the board
      will use those created and moved events to drive materialize and landing
      animations instead of full-screen refresh behavior.
    id: c-2026-05-07t12-59-01-0478860-10-00-agent
  - type: activity
    user: Guy
    date: '2026-05-07T03:04:07.610Z'
    comment: Changed priority from None to Medium.
  - type: comment
    user: Agent
    date: '2026-05-07T13:07:25.6245290+10:00'
    comment: >-
      Completed the live dashboard slice. Task polling now runs through shared
      app state instead of per-screen reload loops, board, backlog, and header
      task views update in place while the portal is visible, and newly created
      or moved tickets now animate into their destination lane with lane-level
      arrival cues. Updated the architecture and ticket-interaction docs to
      match the shipped behavior. Validated with `npm.cmd run build -w portal`
      and a live portal check at `http://localhost:5173/board`. Commit was
      deferred at that point because the worktree still contained unrelated
      shared-file changes.
    id: c-2026-05-07t13-07-25-6245290-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T13:07:25.6245290+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T13:47:25.6568799+10:00'
    comment: >-
      Finalized in commit `76d3314`. This captures the remaining shared-state
      live polling, board/backlog/header refresh cues, and the materialize and
      landing animations for newly created or moved tickets. Validated with
      `npm.cmd run build -w portal` immediately before commit.
    id: c-2026-05-07t13-47-25-6568799-10-00-flux-48
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-07T13:47:25.6568799+10:00'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.950Z'
title: make stuff update in real time without refreshing the page
status: Released
createdBy: Guy
updatedBy: Agent
order: 0
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.950Z'
releaseDocPath: release-notes/v0.1.0
---

## Summary

Make the portal feel live without visible page reloads by polling for ticket
file changes while the app is visible, applying changes through shared app
state, and animating new or moved tickets as they arrive in their destination
lane.

## Notes

Polling should detect file changes and keep the board, backlog, header, and
related ticket surfaces current. Newly created tickets should materialize at
the top of their lane, and status moves should jump into the destination lane
with a stronger landing cue.
