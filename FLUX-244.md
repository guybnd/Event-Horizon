---
priority: High
effort: S
assignee: Agent
tags:
  - bugfix
  - session-management
title: Auto-stop CLI session when ticket moves to Ready
status: Done
createdBy: Unknown
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T12:01:31.919Z'
    comment: Created ticket.
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-13T12:03:16.403Z'
  - type: activity
    user: Agent
    date: '2026-05-13T12:03:16.403Z'
    comment: Updated implementation link.
  - type: comment
    user: Agent
    comment: >-
      Implementation complete. Added session auto-stop logic in routes/tasks.ts
      that triggers when a ticket transitions to Ready status. The fix looks up
      the active session, marks it as completed, and calls adapter.stop() to
      terminate the CLI process. Commit: 3531a19
    date: '2026-05-13T12:03:16.403Z'
    id: c-2026-05-13t12-03-16-403z
implementationLink: 3531a19c6ed8b4c9428e09e6d93eac42e5f84d51
---
## Problem
When a ticket moved to Ready status, the CLI agent session remained open and running. The agent was instructed to "wait for finish command" but the session should have been terminated automatically.

## Root Cause
The tasks.ts PUT endpoint validated that Ready transitions include a comment (lines 161-174), but had no logic to stop the active CLI session associated with that ticket.

## Solution
Added auto-stop logic in `routes/tasks.ts` when a ticket transitions to Ready:
1. Look up the active session ID for the ticket
2. Check if session is running or waiting-input
3. Mark session as completed and set endedAt timestamp
4. Call adapter.stop() to terminate the CLI process
5. Log the auto-stop action for debugging

## Validation
- TypeScript compilation passes
- Logic mirrors the manual stop flow in cli-session.ts
- Session cleanup happens synchronously before ticket update completes

## Files Changed
- `engine/src/routes/tasks.ts`: Added session auto-stop on Ready transition
