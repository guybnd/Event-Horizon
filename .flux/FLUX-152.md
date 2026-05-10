---
assignee: unassigned
tags:
  - bug
  - agent-workflow
  - documentation
priority: High
effort: XS
implementationLink: 477fe8a
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T03:32:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T03:32:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T03:32:00.000Z'
    comment: >-
      Fix complete. Changed `description` → `body` in two places each:
      `.docs/skills/event-horizon-grooming.md` (lines 27, 61) and
      `.claude/rules/event-horizon.md` (lines 150, 184). These are the grooming
      step 6 instruction and the "Text Output vs Ticket Body" clarification
      section. The engine PUT handler has always used `body` — the skill docs
      had the wrong field name, causing agents to silently add a spurious
      `description` key to YAML frontmatter instead of updating the markdown
      body. Awaiting finish command.
    id: c-2026-05-09t03-32-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T03:30:14.666Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T03:30:19.059Z'
    comment: >-
      ```text

      Done. Root cause was wrong field name in the skill docs — the grooming
      instructions told agents to use `description` in the PUT body, but the
      engine's handler destructures `body` by name, so `description` ended up in
      YAML frontmatter instead. Fixed `description` → `body` in 4 places across
      `.docs/skills/event-horizon-grooming.md` and
      `.claude/rules/event-horizon.md`. FLUX-152 is in **Ready** — say `finish
      FLUX-152` to close it.

      ```
  - type: activity
    user: Agent
    date: '2026-05-09T03:33:55.231Z'
    comment: Launched Claude Code session (ac7965d4).
  - type: comment
    user: Agent
    date: '2026-05-09T04:00:00.000Z'
    comment: >-
      Closed. Fixed two instances of wrong field name in
      .docs/skills/event-horizon-grooming.md — grooming step 6 and the "Text
      Output vs Ticket Body" section both now correctly reference `body` instead
      of `description` for PUT /api/tasks/:id. Commit: 477fe8a.
    id: c-2026-05-09t04-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:00:00.000Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T03:35:15.430Z'
    comment: >-
      ```text

      FLUX-152 is **Done**. Commit `477fe8a` fixed the two wrong `description` →
      `body` field references in `.docs/skills/event-horizon-grooming.md`.
      Ticket is closed with implementation link recorded.

      ```
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.355Z'
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
title: agents failing to update stuff correctly
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.355Z'
releaseDocPath: release-notes/0.2.0
---
## Problem

Agents following the grooming skill are told to use `PUT /api/tasks/:id` with a `description` field to update the ticket body. But the engine PUT handler merges the request payload into `{ body, ...frontmatter }` — it destructures `body` by name. Any `description` key ends up in the YAML frontmatter instead of the markdown body, so the body is never rewritten.

This affects:
- Grooming step 6 (rewrite ticket body with plan)
- The "Text Output vs Ticket Body" section in the grooming docs
- Both `.docs/skills/event-horizon-grooming.md` and `.claude/rules/event-horizon.md`

## Root Cause

`engine/src/index.ts:1745` — `const { body, _path, id: _id, ...frontmatter } = { ...task, ...updates };`

The API field for the markdown body is `body`, not `description`. The skill docs were written with the wrong field name.

## Fix

1. In `.docs/skills/event-horizon-grooming.md`: replace `description` field references with `body` in step 6 and in the "Text Output vs Ticket Body" section.
2. In `.claude/rules/event-horizon.md`: same two replacements (this is the live-loaded copy).

## Validation

After the fix, a test PUT with `{ body: "new content" }` should update the markdown body visible in the portal. A PUT with `{ description: "new content" }` should NOT update the body (it would add a spurious frontmatter key).

## Files

- `.docs/skills/event-horizon-grooming.md` — lines 27, 61
- `.claude/rules/event-horizon.md` — lines 150, 184
