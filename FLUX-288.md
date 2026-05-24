---
title: 'Skills: pin WRONG vs RIGHT history-entry examples in orchestrator skill'
status: In Progress
priority: Medium
effort: XS
assignee: unassigned
tags:
  - docs
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-25T10:01:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-25T10:01:00.000Z'
    comment: >-
      Created ticket. Agents repeatedly invent the wrong status_change shape
      (oldStatus/newStatus, fake round-number timestamps) when editing .flux
      files directly. The current skill docs show the right shape but bury it
      mid-doc; agents pattern-match around it.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-25T10:30:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-25T10:35:00.000Z'
    comment: >-
      Added a "Schema landmines" block to the Ticket Model section in
      .docs/skills/event-horizon-orchestrator.md (source) and
      .claude/rules/event-horizon.md (installed copy used by the active
      session). The block calls out three concrete WRONG vs RIGHT examples —
      status_change with oldStatus/newStatus, fabricated round-number
      timestamps, and id-less inline subtasks. Pinned right under the existing
      history-entry examples so it lands in the agent's first read of the skill.
    id: c-2026-05-25t10-35-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T10:35:30.000Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-24T14:32:48.676Z'
  - type: agent_session
    sessionId: 93e96aa7-fa42-41ae-9824-1d28b02fba4e
    startedAt: '2026-05-24T14:32:48.697Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-24T14:32:48.697Z'
---

## Problem / Motivation

The orchestrator skill at [.claude/rules/event-horizon.md](.claude/rules/event-horizon.md) documents the canonical history-entry shape, but agents (Gemini CLI, Claude Code, Copilot) keep emitting wrong variants:

- `oldStatus`/`newStatus` instead of `from`/`to`
- Round-number timestamps like `2026-05-24T14:00:00.000Z` instead of real `Date.now()` ISO strings
- Inline subtask objects without `id` (see FLUX-286)

Reading the skill docs, the correct shape is shown — but as a generic example, not a "do this, not that" anti-pattern callout. Models pattern-match against training-data conventions and miss the project-specific shape.

## Implementation Plan

### Step 1: Add a pinned WRONG vs RIGHT block to the orchestrator skill

In [.claude/rules/event-horizon.md](.claude/rules/event-horizon.md), under "Ticket Model", add a clearly-marked block that shows:

- ✅ Correct `status_change` with `from`/`to` and a real ISO timestamp
- ❌ `oldStatus`/`newStatus` (will fail validation gates)
- ❌ Round-number timestamps (looks fabricated)
- ✅ Correct inline subtask shape (with `id`)
- ❌ Inline subtask without `id` (silently skipped)

Keep it tight — one block, near the top of "Ticket Model", not a separate section.

### Step 2: Mirror the same block into the bootstrap skill template

`.flux/skills/` contains the bootstrap copy that gets installed into new workspaces. Make sure both the editable source (`.docs/skills/`) and the bootstrap copy stay in sync.

### Step 3: Validation

- Open the skill in a fresh agent session and confirm the WRONG examples are visible early.
- No code changes; this is documentation only.

## Out of Scope

- Engine-side validation/normalization → [[FLUX-287]].
- Forcing agents to use the API → [[FLUX-289]].
