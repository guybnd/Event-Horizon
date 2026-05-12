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
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-11T05:56:30.985Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:56:30.986Z'
    comment: >-
      Release v0.3.1 complete. 20 tickets moved to Released. Release notes at
      .docs/release-notes/v0.3.1.md. Commit: 0408355. FLUX-183 excluded — still
      in Grooming, will roll into next release.
    id: c-2026-05-11t05-56-30-986z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:56:34.711Z'
    comment: >-
      Release v0.3.1 is shipped.


      **Summary:**

      - 20 tickets moved to `Released` and release notes generated at
      `.docs/release-notes/v0.3.1.md`

      - FLUX-183 (Extract TaskModal hooks) was excluded — still in Grooming,
      will roll into the next release

      - Commit `0408355` ("Release v0.3.1") created with all ticket and release
      note changes

      - FLUX-190 closed as Done
  - type: activity
    user: Agent
    date: '2026-05-11T05:56:34.721Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-05-11T05:56:53.775Z'
  - type: comment
    user: Guy
    date: '2026-05-11T05:57:41.505Z'
    comment: >-
      1. you need to cleanup the titles to be user friendly explanatory and nice
      for the public repo

      2. you need to do a release and upload it to github

      3. make sure the releases skill reflects that this needs to be done EVERY
      release
    replyTo: c-2026-05-11t05-56-30-986z
    id: c-2026-05-11t05-57-41-497z
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-11T05:57:41.505Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-11T05:57:41.570Z'
    comment: Launched Claude Code session (3942a592).
  - type: status_change
    from: Done
    to: In Progress
    user: Guy
    date: '2026-05-11T05:57:48.215Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:59:16.319Z'
    comment: >-
      Rewrote v0.3.1 release notes with clean, public-friendly titles grouped by
      category (Performance, Token Cost Tracking, Agent Workflow, Reliability,
      Developer Experience, UI & UX). Published GitHub release at
      https://github.com/guybnd/Event-Horizon/releases/tag/v0.3.1. Updated
      release skill to mandate both note rewriting and GitHub publishing as hard
      gates every release. Committed eca9ce0 and pushed.
    id: c-2026-05-11t05-59-16-319z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:59:20.339Z'
    comment: >-
      Done. Here's what was completed:


      1. **Release notes rewritten** — `v0.3.1.md` now has clean,
      public-friendly descriptions grouped into 6 categories instead of raw
      internal ticket titles.


      2. **GitHub release published** —
      https://github.com/guybnd/Event-Horizon/releases/tag/v0.3.1 is now live
      with the polished notes.


      3. **Release skill updated** — Steps 4 and 6 are now `[MANDATORY]` hard
      gates requiring note rewriting and GitHub publishing every release.


      4. **Committed and pushed** — `eca9ce0` on master.
  - type: activity
    user: Agent
    date: '2026-05-11T05:59:20.342Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-11T06:00:12.973Z'
    comment: upload mac and win builds as well
    id: c-2026-05-11t06-00-12-968z
  - type: comment
    user: Guy
    date: '2026-05-11T06:00:22.678Z'
    comment: should be in instructions too
    replyTo: c-2026-05-11t06-00-12-968z
    id: c-2026-05-11t06-00-22-674z
  - type: activity
    user: Agent
    date: '2026-05-11T06:02:06.947Z'
    comment: Launched Claude Code session (f0f82d95).
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-11T06:05:07.531Z'
  - type: comment
    user: Agent
    date: '2026-05-11T06:05:07.533Z'
    comment: >-
      Uploaded Mac (event-horizon-macos.zip, 33MB) and Win
      (event-horizon-win.exe, 83MB) builds to GitHub release v0.3.1. Updated
      release skill with [MANDATORY] step 7 requiring both platform builds every
      release. Committed cbe0c3a and pushed.
    id: c-2026-05-11t06-05-07-533z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T06:05:11.227Z'
    comment: >-
      Done. Here's what was completed:


      1. **Mac and Win builds uploaded** to the [v0.3.1 GitHub
      release](https://github.com/guybnd/Event-Horizon/releases/tag/v0.3.1) —
      `event-horizon-macos.zip` (33MB) and `event-horizon-win.exe` (83MB) are
      now attached.


      2. **Release skill updated** — step 7 is now a `[MANDATORY]` hard gate
      requiring both platform builds to be uploaded every release via `gh
      release upload`.


      3. **Committed and pushed** — `cbe0c3a` on master. FLUX-190 closed as
      Done.
  - type: activity
    user: Agent
    date: '2026-05-11T06:05:11.229Z'
    comment: Claude Code session ended with code 0.
title: do release 0.3.1
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 1190741
  outputTokens: 15060
  costUSD: 0.876992
  costIsEstimated: false
  cacheReadTokens: 1053879
  cacheCreationTokens: 67656
order: 0
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
