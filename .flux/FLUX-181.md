---
priority: Medium
effort: XS
assignee: unassigned
tags:
  - bug
  - engine
  - backend
  - reliability
createdBy: Unknown
updatedBy: Agent
title: 'Engine should stamp history entry dates server-side, not trust client'
status: Released
history:
  - type: activity
    user: Unknown
    date: '2026-05-10T13:42:27.993Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T14:09:48.748Z'
    comment: Launched Claude Code session (88097b53).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T14:10:49.901Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:10:49.903Z'
    comment: >-
      Plan: overwrite date on all incoming history entries in the POST
      /api/tasks handler with the server-generated createdAt timestamp. The PUT
      handler already does this for novel entries (lines 1993-2001). One-line
      fix: map normalizedHistory.history entries to stamp their date with
      createdAt before passing to ensureCreationActivity.
    id: c-2026-05-10t14-10-49-903z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T14:10:53.464Z'
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:58.972Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-10T14:16:01.295Z'
    comment: Launched Claude Code session (741bf585).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T14:16:32.889Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:16:32.890Z'
    comment: >-
      Implementation already complete. POST handler (line 1913) stamps all
      incoming history entry dates with the server-generated createdAt via
      .map((e) => ({ ...e, date: createdAt })). PUT handler (lines 1996-2001)
      stamps all novel entries with a server-side activityTimestamp. Clients
      cannot supply arbitrary history dates on either endpoint. No code changes
      required — the fix was applied in the session that moved this ticket to In
      Progress.
    id: c-2026-05-10t14-16-32-890z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T14:16:35.301Z'
    comment: >-
      FLUX-181 is already fully implemented. Both the `POST` and `PUT` handlers
      overwrite client-supplied history entry dates with server-generated
      timestamps — the fix was applied during the previous session. I've moved
      the ticket to **Ready** with a completion summary.
  - type: activity
    user: Agent
    date: '2026-05-10T14:16:43.179Z'
    comment: Launched Claude Code session (e2d03fb8).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T14:17:14.478Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:17:14.479Z'
    comment: >-
      Closed. POST handler now maps all incoming history entries through ({
      ...e, date: createdAt }) before normalizeHistoryEntries, so clients can
      never supply arbitrary dates on ticket creation. PUT handler stamps novel
      history entries with a server-side activityTimestamp (unchanged, already
      correct). One-line change to engine/src/index.ts. Commit: a507f9d.
    id: c-2026-05-10t14-17-14-479z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T14:17:16.874Z'
    comment: >-
      FLUX-181 is closed. Commit `a507f9d` — POST handler now stamps all
      incoming history entry dates with the server-generated `createdAt`,
      preventing clients from supplying arbitrary dates. Ticket moved to Done.
  - type: activity
    user: Agent
    date: '2026-05-10T14:17:39.918Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-11T05:55:56.960Z'
version: v0.3.1
releasedAt: '2026-05-11T05:55:56.960Z'
releaseDocPath: release-notes/v0.3.1
---
## Root Cause

The engine trusts the `date` field on incoming history entries rather than stamping them server-side. On both `POST /api/tasks` and `PUT /api/tasks/:id`, history entries pass through `normalizeHistoryEntries` without their `date` field being overwritten. Any client (or agent) can supply an arbitrary date — past or future.

Confirmed in `engine/src/index.ts`: `createdAt` is correctly generated via `new Date().toISOString()` for the ticket itself, but individual history entry dates from the request body are preserved verbatim.

## Fix

In the history ingestion path (either inside `normalizeHistoryEntries` or at the `POST`/`PUT` handler level), overwrite the `date` field on any incoming history entry with `new Date().toISOString()`. The client should never be able to set this value.

## Files

- `engine/src/index.ts` — `normalizeHistoryEntries` function and the `POST /api/tasks` + `PUT /api/tasks/:id` handlers
