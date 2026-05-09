---
priority: Medium
effort: XS
tags:
  - agent-workflow
  - engine
assignee: Agent
updatedBy: Agent
id: FLUX-162
title: Atomic requireInput flag to prevent orphaned user-question comments
status: Done
createdBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-09T08:06:44.599Z'
    comment: Created ticket.
---
## Problem

Agents could post a question as a history comment without flipping the ticket status to `Require Input`, leaving the focused-input UI invisible to the user. FLUX-151 triggered this — the agent asked a question in a comment but never transitioned the status, so the prompt was never surfaced.

## Solution

### Engine change
Added `requireInput: true` field to `PUT /api/tasks/:id`. When present, the engine atomically sets `status` to the configured `requireInputStatus` (from `.flux/config.json`, default `Require Input`) in the same write as the comment — no separate API call required and no opportunity to forget.

### Skill doc updates
- `event-horizon-grooming.md` step 5: hard gate added — posting a question comment without `requireInput: true` in the same payload is a grooming failure.
- `event-horizon-implementation.md` step 9: same rule applied to mid-implementation clarification questions.

## Files changed
- `engine/src/index.ts` — `PUT /api/tasks/:id` handler
- `.docs/skills/event-horizon-grooming.md`
- `.docs/skills/event-horizon-implementation.md`

## Validation
Built and confirmed engine hot-reloaded. FLUX-151 manually corrected to `Require Input` as a one-off fix before this change landed.
