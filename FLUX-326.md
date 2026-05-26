---
id: FLUX-326
title: Guard workspace switch against running agent sessions
status: Released
priority: Medium
effort: S
assignee: unassigned
tags:
  - feature
  - engine
  - portal
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-26T01:24:35.244Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    comment: >-
      Implemented in same commit as FLUX-298/324. Engine returns 409 when
      sessions active, portal shows confirmation to force-stop and switch.
    date: '2026-05-26T01:24:39.855Z'
    id: c-2026-05-26t01-24-39-855z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-26T01:24:53.271Z'
implementationLink: b699db2
version: v0.10.0
releasedAt: '2026-05-26T01:24:53.271Z'
releaseDocPath: release-notes/v0.10.0
---
## Problem / Motivation

Switching workspaces while agent sessions are running leaves orphaned processes writing to the old project. The engine's in-memory state moves to the new workspace but agents keep running against old files.

## Implementation

- Added `getActiveSessionCount()` to session-store
- `/api/workspaces/switch` returns 409 with `{ error: 'active_sessions', activeSessions, message }` if sessions are active and `force` is not set
- When `force: true`, calls `stopAllCliSessions('workspace-switch')` before proceeding
- Portal shows a confirm dialog: "[N] agent sessions are still running. Stop them and switch anyway?"
- Both WorkspaceSwitcher (header dropdown) and WorkspaceSection (settings) handle the blocked response
