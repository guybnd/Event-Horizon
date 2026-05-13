---
priority: High
effort: S
assignee: Agent
tags:
  - bugfix
  - session-management
id: FLUX-244
title: Auto-stop CLI session when ticket moves to Ready
status: Ready
createdBy: Unknown
updatedBy: Unknown
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T12:01:31.919Z'
    comment: Created ticket.
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
