---
priority: Medium
effort: L
tags:
  - refactor
  - portal
  - ui-ux
assignee: unassigned
id: FLUX-345
title: 'Portal: decompose TaskModal and TaskCard god components'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:29.120Z'
    comment: Created ticket.
---
## Problem

`portal/src/components/TaskModal.tsx` is 1,623 lines and `TaskCard.tsx` is 1,415 lines. The `task-modal/` subfolder was created as a split-out target (5 sub-files exist) but the parent didn't shrink. Re-renders cascade and the files are painful for agents to read end-to-end.

## Plan

- Treat `TaskModal` and `TaskCard` as **layouts** that compose primitives, not containers that render everything inline.
- Move inline JSX blocks into the `task-modal/` folder: e.g. `BodySection`, `SubtaskList`, `AttachmentRail`, `BranchStatusRow`, `AgentLauncherStrip`.
- For `TaskCard`: extract `CardMetadataRow`, `CardActionButtons`, `CardLiveBadge`, `CardSubtaskBadge`.
- Acceptance: neither file exceeds 500 lines; no behavior regressions; visual snapshots match.
