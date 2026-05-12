---
priority: Low
effort: XS
tags:
  - bug
  - engine
assignee: unassigned
createdBy: Unknown
title: POST /api/tasks should default projectKey to the configured project
status: Released
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-11T04:05:56.154Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T04:06:21.559Z'
    comment: Launched Claude Code session (c5a22d79).
  - type: activity
    user: Agent
    date: '2026-05-11T04:06:35.973Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-11T04:06:39.733Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:06:39.736Z'
    comment: >-
      One-line fix: changed hardcoded 'PROJECT' fallback to use
      configCache.projects?.[0] first, in engine/src/routes/tasks.ts:32.
    id: c-2026-05-11t04-06-39-736z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T04:06:43.986Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:06:43.988Z'
    comment: >-
      Implementation complete. Changed pKey fallback in POST /api/tasks to use
      configCache.projects?.[0] before the hardcoded 'PROJECT' sentinel. New
      tickets created without an explicit projectKey now inherit the workspace's
      configured project key (e.g. FLUX-N). No other callers affected.
    id: c-2026-05-11t04-06-43-988z
  - type: activity
    user: Agent
    date: '2026-05-11T04:06:47.083Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T04:08:34.566Z'
    comment: Launched Claude Code session (19a03daa).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T04:08:55.882Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:08:55.883Z'
    comment: >-
      Committed in a562db5. Single-line change to pKey fallback —
      configCache.projects[0] now takes priority over the hardcoded PROJECT
      sentinel.
    id: c-2026-05-11t04-08-55-883z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T04:09:01.231Z'
    comment: >-
      FLUX-197 is closed. Commit `a562db5` — `POST /api/tasks` now inherits the
      workspace project key instead of falling back to the hardcoded `'PROJECT'`
      string.
  - type: activity
    user: Agent
    date: '2026-05-11T04:52:31.942Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-11T05:55:57.053Z'
tokenMetadata:
  inputTokens: 109596
  outputTokens: 646
  costUSD: 0.09006
  costIsEstimated: false
version: v0.3.1
releasedAt: '2026-05-11T05:55:57.053Z'
releaseDocPath: release-notes/v0.3.1
---
## Problem

`POST /api/tasks` defaults `projectKey` to the hardcoded string `'PROJECT'` when none is provided:

```ts
const pKey = projectKey || 'PROJECT';
```

This means any caller that omits `projectKey` gets tickets named `PROJECT-1`, `PROJECT-2`, etc. instead of the workspace's configured project (e.g. `FLUX`).

## Fix

Fall back to the first entry in `configCache.projects` (already available in scope) rather than the hardcoded string:

```ts
const pKey = projectKey || configCache.projects?.[0] || 'PROJECT';
```

File: `engine/src/routes/tasks.ts`, line ~32.
