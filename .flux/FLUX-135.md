---
assignee: Claude Code
tags:
  - agent
  - integration
  - workflow
priority: High
effort: L
implementationLink: ''
subtasks:
  - >-
    Spawn claude CLI sessions with --dangerously-skip-permissions so the agent
    can act without interruption by default
  - >-
    Detect permission denial in session output and transition the ticket to
    Require Input automatically
  - >-
    Add a one-click Grant Permissions button in the ticket modal Agent Session
    panel
  - >-
    Surface the blocked reason in the ticket timeline so the user knows what was
    denied
  - 'Document the permission model, risks, and recommended usage in .docs'
history:
  - type: activity
    user: Guy
    date: '2026-05-08T13:17:07.388Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-08T13:19:42.741Z'
    comment: Updated description.
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:21:07.308Z'
    comment: >-
      Two interpretations of the ticket: A) allow-list hygiene in
      settings.local.json, or B) spawned CLI subprocess permissions. Asked Guy
      for clarification.
    id: c-2026-05-08t13-21-07-308z
  - type: comment
    user: Guy
    date: '2026-05-08T13:22:27.618Z'
    comment: >-
      we need to ensure claude instance spawns with MOST permissions. we need to
      add a stage that it can pass the ticket to Require input status if doesnt
      have permission. and we need to have a interface where user can grant him
      permission with a click from the ticket here. how to accomplish all this
    replyTo: c-2026-05-08t13-21-07-308z
    id: c-2026-05-08t13-22-27-618z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:25:00.000Z'
    comment: >-
      ## Grooming


      Three distinct problems from the clarification:


      **1. Spawn with maximum permissions**

      The engine currently spawns `claude` with no permission flags. Fix: add
      `--dangerously-skip-permissions` to the spawn args in
      `engine/src/index.ts` so the agent can read files, run bash, and edit code
      without being blocked mid-task. This is appropriate because the session is
      scoped to the workspace and the user explicitly initiated it from the
      ticket UI.


      **2. Detect blocks and surface as Require Input**

      Even with elevated permissions, some actions may be denied. The engine
      stream-json parser needs to detect these — a `tool_use_blocked` event type
      or recognisable stderr pattern — and automatically transition the ticket
      to `Require Input` with an activity entry explaining what was blocked.


      **3. One-click Grant Permissions from the ticket UI**

      The ticket modal needs a Grant Permissions button that appears when the
      session is blocked. Clicking it resumes the session with the elevated flag
      without the user needing to touch the CLI. This is a small addition to the
      Agent Session panel in `TaskModal.tsx`.


      **Touchpoints:** `engine/src/index.ts` (spawn args + block detection),
      `portal/src/components/TaskModal.tsx` (grant button),
      `portal/src/types.ts` (session status extension if needed).
    id: c-2026-05-08t13-25-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Claude Code
    date: '2026-05-08T13:25:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Claude Code
    date: '2026-05-08T13:35:00.000Z'
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:35:00.000Z'
    comment: >-
      ## Implementation in progress


      **Done:**

      - Added `--dangerously-skip-permissions` to spawn args for both initial
      launch and `--resume` reply processes in `engine/src/index.ts`

      - Added `blockedReason` field to `CliSessionSummary` and
      `CliSessionRecord`

      - Added `tool_use_blocked` and permission-error detection in the
      stream-json parser for both the initial session and reply processes — on
      detection, flushes output, sets `status: waiting-input`, and transitions
      the ticket to `Require Input` with an activity entry

      - Added `blockedReason` to portal `types.ts`

      - Added **Grant Permissions & Resume** button to the Agent Session panel
      in `TaskModal.tsx` — appears when `cliSession.blockedReason` is set, shows
      the blocked reason, sends a continuation message to the active session on
      click


      **Remaining:** verify end-to-end in the UI, then commit.
    id: c-2026-05-08t13-35-00-000z
  - type: status_change
    from: Todo
    to: In Progress
    user: Claude Code
    date: '2026-05-08T13:29:39.586Z'
  - type: activity
    user: Claude Code
    date: '2026-05-08T13:29:39.586Z'
    comment: Changed assignee from unassigned to Claude Code.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-08T14:00:33.911Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:00:35.191Z'
    comment: Launched Claude Code session (50cf1a02).
title: >-
  CLI session permissions: spawn with max permissions, block on prompt, grant
  from ticket UI
status: Ready
createdBy: Guy
updatedBy: Agent
order: 0
---
## Problem / Motivation

When Event Horizon launches a Claude Code subprocess via the CLI session feature, the spawned process runs with default permission settings — meaning it will pause mid-task to ask for approval on file edits, bash commands, and other tool use. This breaks the seamless agent workflow. Additionally, there is currently no way for the agent to signal that it is blocked on a permission decision, and no way for the user to grant that permission from inside the ticket UI without switching to the terminal.

## Goals

1. Spawned Claude sessions should start with maximum permissions so the agent can complete its work uninterrupted.
2. If the agent is blocked by a permission denial (OS-level, API limit, or tool restriction), the ticket should automatically move to `Require Input` and surface the reason.
3. The user should be able to grant permissions and resume the session with a single click from the ticket modal — no terminal required.

## Implementation Plan

1. **Spawn with `--dangerously-skip-permissions`** — add the flag to the `claudeArgs` array in `engine/src/index.ts` where the session process is spawned. This is safe because the session is workspace-scoped and explicitly user-initiated.
2. **Detect permission blocks** — in the stream-json parser, watch for `tool_use_blocked` event types and recognisable stderr patterns. On detection, call `updateTaskWithHistory` to append a blocked activity entry and transition the ticket to `Require Input`.
3. **Grant Permissions button in the ticket modal** — add a button to the Agent Session panel in `TaskModal.tsx` that appears when `cliSession.status === waiting-input` and a block was detected. Clicking it re-launches or resumes the session with the elevated permission flag.
4. **Surface the blocked reason** — include the tool name and reason from the `tool_use_blocked` event in the activity entry so the user understands what was denied.
5. **Document** — update `.docs/event-horizon/workflow/` with the permission model, when skip-permissions is used, and known risks.

## Touchpoints

- `engine/src/index.ts` — spawn args, stream-json block detection, status transition
- `portal/src/components/TaskModal.tsx` — Grant Permissions button in Agent Session panel
- `portal/src/types.ts` — extend `CliSessionStatus` if a new `blocked` state is needed
- `.docs/event-horizon/workflow/`
