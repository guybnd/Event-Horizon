---
assignee: Agent
tags:
  - bug
  - agent-workflow
  - reliability
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T13:57:04.892Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-10T05:20:35.653Z'
    comment: >-
      Investigation finding from FLUX-167 (2026-05-10):


      A specific failure mode was observed: session spawned, moved ticket to
      Require Input, updated metadata — then exited without posting the
      mandatory question comment. The ticket ended up in a broken Require Input
      state with no visible question for the user.


      Pattern: status change writes succeed but the follow-up comment write is
      skipped/lost before session exit. Distinct from "session ends mid-work" —
      here the session considered itself done after the status change, treating
      the comment as optional.


      Suspected causes:

      1. Agent treating patch-ticket metadata update + status change as
      sufficient, not recognising the comment as a hard requirement

      2. Context window pressure causing early exit after the first successful
      write

      3. patch-ticket CLI returning success on status change, triggering session
      teardown before the comment step


      This should be investigated in the grooming skill rules and/or the
      patch-ticket tooling to enforce comment-before-status-change ordering for
      Require Input transitions.
    id: c-2026-05-10t05-20-35-631z
  - type: activity
    user: Guy
    date: '2026-05-10T05:20:35.653Z'
    comment: >-
      Changed assignee from unassigned to Agent. Updated tags to bug,
      agent-workflow, reliability. Changed priority from None to High. Changed
      effort from None to M.
  - type: activity
    user: Agent
    date: '2026-05-10T05:21:16.083Z'
    comment: Launched Claude Code session (e7b712ed).
  - type: comment
    user: Agent
    date: '2026-05-10T05:24:29.058Z'
    comment: >-
      Root cause identified (2026-05-10) for the silent-update failure seen in
      FLUX-167:


      When this agent (running in the main Claude Code chat session) calls PUT
      /api/tasks/:id directly via curl/fetch, it is hitting the running dev
      engine which requires a workspace to be active via requireWorkspace()
      middleware. If the workspace is not loaded in that engine instance, the
      engine returns 503 NO_WORKSPACE JSON — but the agent's response-parsing
      code only checks for a success-shaped field (e.g. 'id') and silently
      treats the 503 as success.


      Result: the agent believes the ticket was updated, moves on, and the
      ticket remains unchanged. No error is surfaced.


      This is distinct from the premature-session-exit pattern but compounds it:
      even if a session tries to recover and write a comment, the write can
      silently fail with no indication.


      Two failure modes now documented for FLUX-140:

      1. Session exits after status change before writing the mandatory comment
      (originally observed)

      2. API writes appear to succeed but are silently dropped due to 503
      workspace-not-set response being misread as success


      Fix directions:

      - Workspace guard: agent API calls should always verify workspace is set
      before PUT/POST (or detect 503 code explicitly)

      - Response validation: check HTTP status code not just response body shape

      - For the session-exit case: patch-ticket CLI is more reliable than direct
      API calls from outside a running session since it sets --workspace
      explicitly
    id: c-2026-05-10t05-24-29-058z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-10T05:24:30.128Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:24:30.129Z'
    comment: >-
      Starting implementation: engine enforcement for requireInput+comment
      atomicity, patch-ticket CLI guard, and skill rule reinforcement.
    id: c-2026-05-10t05-24-30-129z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-10T05:26:07.852Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:26:07.853Z'
    comment: >-
      Fix shipped (2026-05-10): engine now falls back to cwd when no workspace
      is configured on startup. If the current working directory contains a
      .flux/ directory, it is automatically activated — no manual workspace
      selection needed. This eliminates the silent 503 failure mode for agent
      API calls made from within a project directory. Change in
      engine/src/index.ts startup block (~line 2413).
    id: c-2026-05-10t05-26-07-853z
  - type: status_change
    from: Done
    to: In Progress
    user: Agent
    date: '2026-05-10T05:26:13.467Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:26:13.468Z'
    comment: >-
      Reverting Done — partial fix only. The cwd fallback addresses the silent
      503 API write failure but the premature session exit bug (session exits
      after status change without posting the Require Input question comment) is
      still open.
    id: c-2026-05-10t05-26-13-468z
  - type: comment
    user: Agent
    date: '2026-05-10T05:27:03.130Z'
    comment: >-
      All changes are in the working tree but not yet committed. Files changed:
      engine/src/index.ts (requireInput guard + cwd fallback),
      engine/src/patch-ticket.ts (requireInput guard),
      .docs/skills/event-horizon-grooming.md,
      .docs/skills/event-horizon-implementation.md,
      .claude/rules/event-horizon.md. Awaiting 'finish FLUX-140' to commit.
    id: c-2026-05-10t05-27-03-130z
  - type: status_change
    from: In Progress
    to: Grooming
    user: Agent
    date: '2026-05-10T05:27:16.180Z'
  - type: status_change
    from: Grooming
    to: Ready
    user: Agent
    date: '2026-05-10T05:32:03.050Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:32:03.051Z'
    comment: >-
      All three prongs implemented and verified: engine 400 guard, patch-ticket
      CLI guard, and skill rule reinforcement across all four skill files.
      Awaiting finish commit.
    id: c-2026-05-10t05-32-03-051z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T05:32:23.110Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:32:23.111Z'
    comment: >-
      Shipped in commit 3211696. Engine guard, CLI guard, and skill rule
      reinforcement all confirmed present in working tree before commit.
    id: c-2026-05-10t05-32-23-111z
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.931Z'
title: Fix agent sessions terminating prematurely during active work
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.931Z'
releaseDocPath: release-notes/v0.3.0
---
## Problem

Agent sessions end prematurely (or writes fail silently), leaving tickets in broken intermediate states. Two confirmed failure modes:

1. **Silent-exit after status change** — agent transitions ticket to `Require Input` then exits before writing the mandatory question comment. Ticket ends up in `Require Input` with no visible question.
2. **Silent API failure** — direct API calls return 503 (`NO_WORKSPACE`) but the agent parses the response body for a success field rather than checking HTTP status, so the write appears to succeed but is silently dropped.

## Root Cause

Both modes share the same structural flaw: the status change and the question comment are treated as two separate sequential writes. If anything interrupts after the first write (session exit, context pressure, API error), the second write is lost with no feedback.

## Fix

**Three-pronged: enforce atomicity at the API layer, the CLI layer, and in the skill rules.**

### 1. Engine enforcement (`engine/src/index.ts`) ✅ Done

In `PUT /api/tasks/:id`, before processing a request that transitions to `requireInputStatus`:
- Check that the submitted `history` array contains at least one new `{type: 'comment'}` entry beyond what already exists on the ticket.
- If no comment is present, reject with `400 REQUIRE_INPUT_MISSING_COMMENT`.

This makes it structurally impossible to set `Require Input` without a question in the same atomic request.

### 2. patch-ticket CLI guard (`engine/src/patch-ticket.ts`) ✅ Done

When `--status` matches the configured `requireInputStatus`:
- Read `config.json` to get the actual configured value (defaulting to `'Require Input'`).
- If `--comment` is absent, exit with an error before writing anything.

This blocks the CLI path that bypasses the API.

### 3. Skill rule reinforcement ✅ Done

Updated all four skill files (orchestrator CLAUDE.md embed, `.docs/skills/event-horizon-grooming.md`, `.docs/skills/event-horizon-implementation.md`) to note that the engine now enforces this with `REQUIRE_INPUT_MISSING_COMMENT`, so agents understand the 400 error they will get if they attempt a comment-free transition.

## Files Changed

- `engine/src/index.ts` — guard in `PUT /api/tasks/:id` handler
- `engine/src/patch-ticket.ts` — `loadRequireInputStatus()` + guard before mutations
- `.docs/skills/event-horizon-grooming.md` — rule step 5 updated
- `.docs/skills/event-horizon-implementation.md` — rule step 9 updated
- `.claude/rules/event-horizon.md` — same updates to embedded grooming and implementation skill modules

## Validation

- `PUT /api/tasks/:id` with `requireInput: true` and no new comment → 400 `REQUIRE_INPUT_MISSING_COMMENT`
- `PUT /api/tasks/:id` with `requireInput: true` and a new comment → succeeds, status set to `Require Input`
- `npx tsx engine/src/patch-ticket.ts FLUX-XXX --workspace . --status "Require Input"` (no `--comment`) → exits with error
- `npx tsx engine/src/patch-ticket.ts FLUX-XXX --workspace . --status "Require Input" --comment "question?"` → succeeds

