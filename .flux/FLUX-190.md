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
    date: '2026-05-11T02:46:26.490Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T02:46:30.923Z'
    comment: Launched Claude Code session (9f93f1e2).
  - type: activity
    user: Agent
    date: '2026-05-11T02:46:53.290Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Guy
    date: '2026-05-11T03:43:28.522Z'
    comment: Changed priority from None to Critical.
  - type: activity
    user: Agent
    date: '2026-05-11T05:54:40.864Z'
    comment: Launched Claude Code session (a5478f15).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T05:55:47.709Z'
  - type: activity
    user: Agent
    date: '2026-05-11T05:55:47.709Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T05:55:53.371Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:55:53.372Z'
    comment: 'Starting release: running flux:release v0.3.1 for 20 Done tickets.'
    id: c-2026-05-11t05-55-53-372z
title: do release 0.3.1
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 65234
  outputTokens: 863
  costUSD: 0.079592
  costIsEstimated: false
---
## Release v0.3.1

Run the release script to package all 20 Done tickets into v0.3.1.

**FLUX-183** (Extract TaskModal hooks) is still in Grooming and will NOT be included — it will roll into a future release.

### Steps
1. Run `npm run flux:release v0.3.1` from the engine directory
2. Review generated release notes in `.docs/release-notes/`
3. Commit the release artifacts
4. Close this ticket

### Done Tickets (20)
- FLUX-150: token spend optimization
- FLUX-172: identify refactor opportunities to make code more readable
- FLUX-174: comment box is really choppy
- FLUX-179: Make a new release incremental version 0.3
- FLUX-180: Fix ticket modal blank page and lag on open
- FLUX-181: Engine should stamp history entry dates server-side
- FLUX-182: Split engine/src/index.ts into focused modules
- FLUX-186: code review comments are discarded
- FLUX-187: token cost badge: clickable toggle, cached/fresh split, color thresholds
- FLUX-188: lag on typing comment box during active agent session
- FLUX-189: all tickets marked as dirty even with no changes
- FLUX-194: add animated activity badge on cards while agent is working
- FLUX-195: ticket silently disappears from board after engine restart
- FLUX-196: Portal build breaks repeatedly due to linter reverting unused-var fixes
- FLUX-197: POST /api/tasks should default projectKey to configured project
- FLUX-204: new task window improvement UX
- FLUX-205: token counter broken after last refactor
- FLUX-206: grooming almost never asks for user input
- FLUX-207: unread filter pill should show unread count
- PROJECT-2: Reduce per-turn token cost of the agent workflow
