---
assignee: Agent
tags:
  - bug
priority: High
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-10T10:50:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Done
    user: Agent
    date: '2026-05-10T10:50:01.000Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:50:01.000Z'
    comment: >-
      Fixed. Root cause: the agent launch prompt in engine/src/index.ts had no
      status field and a generic "respond with progress updates" closing line.
      When relaunched on a ticket whose prior session completed the work but
      left it In Progress, the agent saw no actionable context and exited
      cleanly with code 0. Fixed by adding `Current status` to the prompt header
      and a status-aware action instruction: In Progress instructs the agent to
      move to Ready with a completion comment if work is done and not to exit
      without updating status; Todo instructs it to begin and close out; Ready
      instructs it to wait for the finish command.
    id: c-2026-05-10t10-50-01-000z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.940Z'
title: agent sessions exit without closing ticket when relaunched on In Progress work
status: Released
createdBy: Agent
updatedBy: Agent
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.940Z'
releaseDocPath: release-notes/v0.3.0
---

## Problem

When a Claude Code session is relaunched on an In Progress ticket (e.g. after a prior session ended mid-work), the agent received no `status` field in its prompt and a generic "respond with progress updates" instruction. If the prior session had already completed the implementation, the agent correctly concluded there was nothing to do and exited cleanly — leaving the ticket stuck In Progress forever.

Observed on FLUX-177 and FLUX-97 (multiple silent exits with code 0).

## Root Cause

The launch prompt built in `engine/src/index.ts` (`POST /api/tasks/:id/cli-session/start`) was missing:

1. The ticket's current status — the agent had no way to know it was In Progress vs Todo vs Ready
2. A status-aware closing instruction — the prompt just said "respond with progress updates and blockers"

## Fix

Added `Current status: ${taskStatus}` to the prompt header and replaced the generic closing line with a status-aware `actionInstruction`:

- **In Progress** → if implementation is complete, move to Ready and post completion comment; do not exit without updating ticket status
- **Todo** → move to In Progress, complete the work, then move to Ready
- **Ready** → wait for `finish <id>` from the user; do not move further

**File:** `engine/src/index.ts`
