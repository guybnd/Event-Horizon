---
assignee: unassigned
tags:
  - ux
  - bug
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T14:09:50.074Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. ReleasesScreen renders each version as a static card block. Plan:
      add local collapsed state per version using React useState (or a Set),
      render a chevron toggle button in the version header row, and hide the
      task grid when collapsed. Default state: expanded. No routing or
      persistence needed.
    id: c-flux97-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T04:00:08.078Z'
    comment: test inline comment
    replyTo: c-flux97-groom
    id: c-2026-05-08t04-00-08-078z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-10T08:52:35.330Z'
  - type: activity
    user: Guy
    date: '2026-05-10T08:53:13.885Z'
    comment: 'Updated description. Updated tags to ux, bug.'
  - type: activity
    user: Agent
    date: '2026-05-10T09:05:02.117Z'
    comment: Launched Claude Code session (6398d072).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T09:05:35.953Z'
  - type: comment
    user: Agent
    date: '2026-05-10T09:05:35.954Z'
    comment: >-
      Grooming complete. Plan: (1) replace localeCompare sort with semver
      comparator to fix ordering bug, (2) add collapsed Set state + chevron
      toggle button in the version header to hide/show the task grid. Only
      ReleasesScreen.tsx needs to change.
    id: c-2026-05-10t09-05-35-954z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T09:05:38.177Z'
    comment: >-
      Grooming done. The plan covers both issues — the semver ordering fix and
      the collapsible sections. Ready to implement when you give the go-ahead.
  - type: activity
    user: Agent
    date: '2026-05-10T09:06:20.008Z'
    comment: Launched Claude Code session (fdef297d).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T09:06:37.343Z'
  - type: comment
    user: Agent
    date: '2026-05-10T09:06:37.344Z'
    comment: 'Starting implementation: semver sort fix + collapsible sections.'
    id: c-2026-05-10t09-06-37-344z
  - type: activity
    user: Agent
    date: '2026-05-10T09:07:01.939Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-10T09:10:32.970Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T09:11:38.399Z'
  - type: activity
    user: Agent
    date: '2026-05-10T09:11:40.920Z'
    comment: Launched Claude Code session (f63b301b).
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T09:12:55.835Z'
    comment: >-
      The implementation looks complete. The user may have moved the ticket back
      to In Progress for an unrelated reason (perhaps they noticed the corrupted
      ticket body, or wanted to confirm something). The code is correct:


      1. **Semver ordering** — `parseSemver` strips `v` prefix,
      `compareSemverDesc` sorts descending by major/minor/patch

      2. **Collapsible sections** — `collapsed` Set state + chevron icon that
      rotates on collapse, click header to toggle


      The ticket body corruption (duplicated frontmatter embedded in the
      markdown body) has been fixed. The `finish FLUX-97` command was partially
      captured in the body — that's now cleaned up.


      Ready to finish whenever you confirm everything looks good in the portal.
      Just say `finish FLUX-97`.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-10T09:27:33.735Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T10:17:18.124Z'
  - type: activity
    user: Agent
    date: '2026-05-10T10:17:18.165Z'
    comment: Launched Claude Code session (d152db5e).
  - type: activity
    user: Agent
    date: '2026-05-10T10:19:49.464Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-10T10:23:52.966Z'
    comment: Launched Claude Code session (1bccd48a).
  - type: activity
    user: Agent
    date: '2026-05-10T10:24:12.483Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-10T10:56:48.944Z'
  - type: activity
    user: Agent
    date: '2026-05-10T10:56:52.238Z'
    comment: Launched Claude Code session (aa8c8f58).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T10:57:16.257Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:57:16.258Z'
    comment: >-
      Implemented collapsible release version sections and fixed the ordering
      bug. Each version header now has a chevron toggle — click to
      collapse/expand the ticket grid. Added semantic version sorting
      (parseSemver + compareSemverDesc) replacing the previous string-sort which
      caused incorrect ordering. Also shows a ticket count badge per version.
      Commit: 2400d72.
    id: c-2026-05-10t10-57-16-258z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:57:18.711Z'
    comment: >-
      FLUX-97 is done. Commit `2400d72` ships:


      - Collapsible release sections — click the version header (chevron
      indicator) to collapse/expand the ticket grid

      - Semantic version sorting replacing the previous string-sort that caused
      incorrect ordering

      - Ticket count badge on each version header
  - type: activity
    user: Agent
    date: '2026-05-10T11:10:22.232Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.941Z'
title: release surface - make releases collapsible for easy navigation
status: Released
createdBy: Guy
updatedBy: Agent
order: 0
tokenMetadata:
  inputTokens: 453812
  outputTokens: 11941
  costUSD: 0.515668
  costIsEstimated: false
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.941Z'
releaseDocPath: release-notes/v0.3.0
---
# Goal

Allow users to collapse individual release version sections on the Releases screen so they can quickly navigate to older or newer releases without scrolling through all tickets.

also there seems to be some bug where they are not ordered correctly
 navigation
status: In Progress
createdBy: Guy
updatedBy: Agent
order: 0
tokenMetadata:
  inputTokens: 381406
  outputTokens: 11400
  costUSD: 0.440449
  costIsEstimated: false
---
# Goal

Allow users to collapse individual release version sections on the Releases screen so they can quickly navigate to older or newer releases without scrolling through all tickets.

also there seems to be some bug where they are not ordered correctly
