---
id: FLUX-316
title: 'Test: multi-session store API validation'
status: In Progress
priority: High
effort: S
assignee: unassigned
tags:
  - test
  - multi-agent
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-25T14:53:29.779Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: e2a3bec6-57b6-4fde-923a-023bf2bc5b76
    startedAt: '2026-05-25T14:59:29.708Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T14:59:29.708Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T14:59:41.169Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T15:00:11.143Z'
---

## Problem / Motivation

Validate that the FLUX-283 multi-session store refactor works correctly end-to-end via the REST API. This covers the new endpoints, backwards compatibility, file-lock conflict detection, and pattern validation.

## Test Plan

Run the engine (`npm run dev` in `engine/`) and execute the following against a test ticket:

### 1. Backwards compat — single session still works
- `POST /api/tasks/:id/cli-session/start` with `{ "framework": "claude" }` (no role/pattern)
- Verify `GET /api/tasks/:id/cli-session` returns that session
- Verify `GET /api/tasks/:id/cli-sessions` returns array with 1 entry
- Stop it, confirm status goes to cancelled

### 2. Multi-session — two concurrent sessions with roles
- Start session A: `{ "framework": "claude", "role": "reviewer", "pattern": "scatter-gather", "patternPosition": "step" }`
- Start session B: `{ "framework": "claude", "role": "implementer", "pattern": "scatter-gather", "patternPosition": "step" }`
- Verify `GET /api/tasks/:id/cli-sessions` returns 2 entries with correct roles
- Verify `GET /api/tasks/:id/cli-session` returns the most recent active one

### 3. File-lock conflict detection
- Start session C with `{ "framework": "claude", "role": "writer", "lockedPaths": ["src/models/"] }`
- Attempt session D with `{ "framework": "claude", "role": "writer2", "lockedPaths": ["src/models/user.ts"] }`
- Verify 409 response with conflict details (path prefix overlap)
- Attempt session E with `{ "framework": "claude", "role": "safe", "lockedPaths": ["src/routes/"] }` — should succeed (no overlap)

### 4. Pattern validation
- Attempt `{ "framework": "gemini", "role": "lead", "pattern": "supervisor", "patternPosition": "lead" }` → expect 400 (Gemini can't be supervisor lead)
- Attempt `{ "framework": "claude", "role": "lead", "pattern": "supervisor", "patternPosition": "lead" }` → should succeed

### 5. Targeted input/stop
- With multiple active sessions, `POST /api/tasks/:id/cli-session/stop` with `{ "sessionId": "<specific-id>" }` stops only that session
- Other sessions remain active

### 6. Auto-stop on Ready
- Start 2+ sessions on a ticket
- Move ticket status to Ready via `PUT /api/tasks/:id`
- Verify all sessions are cancelled

## Success Criteria

All 6 scenarios pass. No regressions in single-session portal UX.
