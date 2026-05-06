---
id: FLUX-44
title: 'add a status phase : ready to merge'
status: In Progress
priority: High
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags: []
history:
  - type: comment
    user: Guy
    date: '2026-05-06T13:26:34.107Z'
    comment: '1'
    id: c-2026-05-06t13-26-34-107z
  - type: comment
    user: Agent
    date: '2026-05-06T13:52:00.000Z'
    comment: >-
      Plan: add config-backed workflow status names for the existing Require
      Input flow and the new ready-for-review stage, then generalize the prompt
      notification and modal UI so both statuses are treated as user-addressable
      workflow prompts. After that, update the skill and instruction templates
      so agents understand the `finish <ticket>` handoff from the ready state.
    id: c-2026-05-06t13-52-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-06T13:52:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T14:08:00.000Z'
    comment: >-
      Added the ready-for-merge review workflow. Config now includes a
      configurable `readyForMergeStatus` defaulting to `Ready`, the board
      notification count now treats both Require Input and Ready tickets as
      user prompts, the task modal surfaces a dedicated ready-for-review prompt
      with a `finish <ticket>` handoff, and the skill plus Copilot instructions
      were updated so agents understand the finalization flow. Validated with
      `npm.cmd run build -w portal`, `npm.cmd run install-skill -- --target
      c:\GitHub\EventHorizon --framework copilot`, and live API checks for
      `/api/config` and the refreshed installed workflow files. Commit:
      `f789d8d` (`Add ready-for-merge review workflow`).
    id: c-2026-05-06t14-08-00-000z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-06T14:08:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-06T14:16:00.000Z'
    comment: >-
      Follow-up: status-related settings should live together, the user-input
      status should be configurable and restorable, and the earlier change
      should not feel like it is disturbing the rest of the board setup.
    id: c-2026-05-06t14-16-00-000z
  - type: comment
    user: Agent
    date: '2026-05-06T14:20:00.000Z'
    comment: >-
      Reopening for the follow-up. The FLUX-44 feature commit itself only added
      `Ready` and `readyForMergeStatus`, but the workflow controls are still too
      split and `Require Input` is still hardcoded. This follow-up will group
      workflow statuses together in Settings and add a configurable, restorable
      user-input status alongside the ready-for-merge status.
    id: c-2026-05-06t14-20-00-000z
  - type: status_change
    from: Done
    to: In Progress
    user: Agent
    date: '2026-05-06T14:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T00:03:05.5591314+10:00'
    comment: >-
      Refining the follow-up workflow settings UX: the specialized workflow
      statuses should be selected from the existing status entities instead of
      entered as free text. This keeps the workflow config tied to real board
      statuses while preserving the restore action when a configured workflow
      status is currently missing from the board.
    id: c-2026-05-07t00-03-05-5591314-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T00:09:15.2102107+10:00'
    comment: >-
      Completed the FLUX-44 follow-up. Workflow statuses now live together in
      Settings, both specialized workflow selectors use existing board or hidden
      statuses instead of free text, the user-input flow is configurable via
      `requireInputStatus`, and the source plus installed Copilot workflow docs
      were refreshed to match. Validated with `npm.cmd run build -w portal`, a
      live `/api/tasks` check confirming FLUX-44 still parses after ticket
      edits, and `npm.cmd run install-skill -- --target c:\GitHub\EventHorizon
      --framework copilot`. Commit: `584ceb8` (`Tie workflow prompt settings to
      existing statuses`).
    id: c-2026-05-07t00-09-15-2102107-10-00
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T00:09:15.2102107+10:00'
effort: None
implementationLink: '584ceb8'
subtasks: []
---
we should add another user promptable stage, when a ticket is finished in progress state and is ready for user review, it goes into this status that is 'Ready'

1. we should be able to define what Ready state is called in settings
2. we shoud update the relevant skill, skill setup, instructions etc
3. we should make sure that when ticket transition into this state it sets up as a user prompt to be addressed and notifies user accordingly with the notification system
4. in the flow when the prompt window opens, the user can then tell the agent to 'finish [ticket number] which take it from this state into a formalized commit with proper commit message and ticket info update
