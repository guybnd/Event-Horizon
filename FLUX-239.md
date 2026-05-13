---
priority: High
effort: S
tags:
  - agent-workflow
  - engine
id: FLUX-239
title: Enforce completion comment when transitioning ticket to Ready
status: Released
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-05-13T07:09:52.528Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Done
    user: Agent
    date: '2026-05-13T07:10:00.663Z'
  - type: comment
    user: Agent
    date: '2026-05-13T07:10:00.664Z'
    comment: >-
      Implemented. Engine API guard (READY_MISSING_COMMENT), patch-ticket CLI
      guard, and skill doc update all landed in one commit. TypeScript check
      clean. Resolves the pattern of agent sessions ending without updating
      ticket status.
    id: c-2026-05-13t07-10-00-664z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-13T14:16:35.544Z'
version: v0.5.0
releasedAt: '2026-05-13T14:16:35.544Z'
releaseDocPath: release-notes/v0.5.0
---
## Problem

Agent sessions frequently ended without correctly updating tickets. The root cause was that the `Ready` status transition had no enforcement analogous to the existing `Require Input` guard. An agent could:
- Call `--status "Ready"` without a `--comment`, leaving the ticket with no completion summary
- Call them as two separate commands, where the status step could succeed even if the comment step was skipped or forgotten

## Changes

### 1. Engine API guard (`engine/src/routes/tasks.ts`)
Added `READY_MISSING_COMMENT` validation: a `PUT /api/tasks/:id` that transitions to the configured `readyForMergeStatus` without a comment entry in the same request is now rejected with HTTP 400, mirroring the existing `REQUIRE_INPUT_MISSING_COMMENT` pattern.

### 2. patch-ticket CLI guard (`engine/src/patch-ticket.ts`)
Added matching guard at the CLI level: `--status "Ready"` without `--comment` now exits with a clear error before touching the file. Refactored `loadRequireInputStatus` into `loadConfiguredStatuses` to load both `requireInputStatus` and `readyForMergeStatus` from config in a single read.

### 3. Skill documentation update
Updated step 10 in both `.docs/skills/event-horizon-implementation.md` and `.claude/rules/event-horizon.md` to:
- Require a single atomic `patch-ticket --status "Ready" --comment "..."` call
- Reference the `READY_MISSING_COMMENT` error code
- Show a concrete example command
- Explicitly prohibit calling `--status` and `--comment` as separate commands

## Validation
- TypeScript type-check passes (pre-existing errors in claude-code.ts are unrelated)
- Both API and CLI guards tested via code inspection against the existing `requireInput` pattern
- All three config-driven status names are resolved from `configCache` / `config.json` rather than hardcoded
