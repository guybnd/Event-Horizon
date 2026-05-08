---
assignee: unassigned
tags:
  - bug
  - agent-workflow
  - skills
priority: High
effort: S
implementationLink: c945ee8
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T10:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T10:00:00.000Z'
    comment: >-
      Closed. Committed skill file updates as c945ee8. Grooming skill steps 6–7
      are now [MANDATORY]/[HARD GATE]; Implementation skill steps 2–3 are new
      [HARD GATE] checks at startup; Orchestrator checklist has two new
      boldfaced items. Both standalone .docs/skills/ files and the embedded
      skill_modules in .claude/rules/event-horizon.md are in sync.
    id: c-2026-05-09t10-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T10:00:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:53:34.733Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:53:34.733Z'
    comment: Updated implementation link.
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:53:38.836Z'
    comment: >-
      ```text

      FLUX-144 is closed. Commit `c945ee8` contains the two updated skill files.
      The ticket is now `Done` with `implementationLink: c945ee8`.

      ```
    id: c-2026-05-08t14-53-38-836z
title: agents are going rogue and breaking body description
status: Done
createdBy: Guy
updatedBy: Agent
---

## Summary

Strengthen agent-workflow skill files to make three previously-observed failure modes impossible to accidentally skip.

## Failure Modes Addressed

1. **Skipping Todo** — agents jump `Grooming → In Progress` or `Grooming → Ready` without the `Todo` hand-off checkpoint.
2. **Body never rewritten** — agents post the plan as a history comment and leave the ticket body as the original user description, breaking the "any agent can pick this up" contract.
3. **Text output confused with body update** — agents believe sending a chat message constitutes updating the ticket body; it does not.

## Changes Made

### `.docs/skills/event-horizon-grooming.md`

- Step 6 (rewrite body) marked **[MANDATORY]** with "body IS the plan" framing; explicitly requires `PUT /api/tasks/:id` with `description` field.
- Step 7 added as **[HARD GATE]**: do not set `Todo` until body rewrite is confirmed.
- New "Text Output vs Ticket Body" section explains the distinction between chat output and an API body update.

### `.docs/skills/event-horizon-implementation.md`

- Step 2 added as **[HARD GATE]**: verify ticket body contains a real plan before any code; if not, return to grooming.
- Step 3 added as **[HARD GATE]**: verify `Grooming → Todo` history entry exists before setting `In Progress`.
- Remaining steps renumbered.

### `.claude/rules/event-horizon.md`

- Same grooming and implementation module changes mirrored in embedded skill_modules.
- End-to-End Checklist: two new boldfaced items — body rewritten via API before coding; ticket passed through `Todo` with history entry.

## Validation

Read all three updated files and confirmed new rules are present and unambiguous. Both the standalone `.docs/skills/` files and the embedded modules in `.claude/rules/event-horizon.md` are in sync.
