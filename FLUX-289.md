---
title: 'Engine: enforce ticket schema — reject malformed .flux/*.md writes'
status: In Progress
priority: High
effort: M
assignee: unassigned
tags:
  - feature
  - engine
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-25T10:02:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-25T10:02:00.000Z'
    comment: >-
      Created ticket. Agents bypass the engine's PUT /api/tasks/:id endpoint by
      editing .flux/<id>.md directly with their file tools. Direct YAML edits
      skip all validation, leading to recurring schema drift
      (oldStatus/newStatus, id-less inline subtasks, fabricated timestamps).
      User confirmed they are fine with strict enforcement since humans edit
      tickets via the portal UI, not the raw .flux files.
  - type: comment
    user: Agent
    date: '2026-05-25T10:50:00.000Z'
    comment: >-
      Resolved open questions. Timestamps: API write paths already overwrite
      client-supplied dates with server time (routes/tasks.ts:298-301), so no
      new code needed for that. Direct file editing: removing it from the skill
      entirely. Plan condensed to (1) schema validator module, (2)
      validate-on-read with parseErrors integration, (3) validate-on-write in
      API handlers, (4) skill rewrite to API-only.
    id: c-2026-05-25t10-50-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-25T10:50:30.000Z'
  - type: comment
    user: Agent
    date: '2026-05-25T11:30:00.000Z'
    comment: >-
      Implemented. Added engine/src/schema.ts (validateTicketFrontmatter,
      validateHistoryEntry, validateSubtasks, formatValidationErrors). Wired
      validation into loadTask in task-store.ts (read path → parseErrors on
      failure) and into POST/PUT handlers in routes/tasks.ts (write path → 400
      with details on failure). Validation runs after normalizeHistoryEntries so
      legacy oldStatus/newStatus shapes are auto-healed before validation.
      Verified across all 16 existing tickets — zero schema errors after
      normalization. Type-check clean. Skill rewrite complete in .docs/skills/*
      and .claude/rules/event-horizon.md: Persisting Changes now mandates the
      API, with appendHistory replacing direct YAML edits. Caveat: server-side
      timestamp overwrite for appendHistory was already in place at
      routes/tasks.ts:298-301 — no new code needed for that.
    id: c-2026-05-25t11-30-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T11:30:30.000Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-24T14:33:02.141Z'
  - type: agent_session
    sessionId: 309e2a35-427c-472f-8f85-42aafa23fbe5
    startedAt: '2026-05-24T14:33:02.161Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-24T14:33:02.161Z'
---

## Problem / Motivation

Currently the orchestrator skill instructs agents to edit `.flux/<id>.md` directly. This was deliberate — it lets agents work even if the engine isn't running and keeps the YAML files as a transparent source of truth. But in practice it has produced repeated schema drift:

- FLUX-281: malformed `status_change` shape ([[FLUX-287]])
- FLUX-277/278/286: malformed inline subtasks
- Various tickets: fabricated round-number timestamps in history entries

Each issue triggers a follow-up bug ticket, an agent gets blamed, and the next agent makes the same mistake. The root cause is that there is no enforcement boundary — agents write to disk, and only the next read discovers the problem.

The user has confirmed: humans edit tickets through the portal UI (which goes through the API), so we don't lose the "human can edit a ticket" property by routing agent writes through the API too.

## Implementation Plan

### Step 1: Define the canonical schema

Pin down the shape of:
- Ticket frontmatter (`id`, `title`, `status`, `priority`, `effort`, `tags`, `assignee`, `createdBy`, `updatedBy`, `history`, `subtasks`, `implementationLink`).
- History entry types: `activity`, `comment`, `status_change` (from/to), `agent_session`, `agent_message`.
- Subtask shape: string id reference OR full inline object with `id`.

Likely lives in `engine/src/schema.ts` (new file) using a lightweight validator (Zod is already used elsewhere — check) or hand-rolled type guards.

### Step 2: Validate on every write path

The engine has three write surfaces today:
- `routes/tasks.ts` PUT/POST handlers
- `task-store.ts` `updateTaskWithHistory`
- `release.ts` (status moves to Released)

Add a `validateTicket(frontmatter)` call before `fs.writeFile` in each. On failure: log the diff, throw — do not write a half-valid file.

### Step 3: Validate on read (with auto-heal)

When loading `.flux/<id>.md`:
- Run normalizer first (handles legacy `oldStatus`/`newStatus`, see [[FLUX-287]]).
- Run validator second.
- If still invalid: surface the parse error in `parseErrors` (already exists in `task-store.ts`) and refuse to expose the ticket via the API. Portal already has UI for parse errors.

### Step 4: Update the skill instructions

Rewrite [.claude/rules/event-horizon.md](.claude/rules/event-horizon.md) "Persisting Changes" section:
- Default path: `PUT /api/tasks/:id` with `appendHistory` and field updates. Engine validates and writes the file.
- Direct file editing is allowed only when the engine isn't running, and agents should expect strict validation on next load.

Add a small helper command or `flux-cli` wrapper if needed so agents have a one-liner instead of constructing curl payloads.

### Step 5: Migration

- Run validator across all existing `.flux/*.md` to surface latent schema drift.
- Fix anything that fails (likely just FLUX-281 + a handful).
- This is one-shot, manual.

### Step 6: Validation

- New ticket created via API: passes validation, lands on disk correctly.
- Manually corrupt a ticket file (e.g., `oldStatus`): engine refuses to serve it with a clear error in the portal.
- Agent session that tries to write malformed YAML directly: next API read fails fast instead of corrupting downstream state.

## Decisions (resolved 2026-05-25)

- **Timestamps:** Server overwrites client-supplied `date` fields with the server's current ISO timestamp when writing history entries via the API. Eliminates fabricated timestamps for the API-mediated path. Read-time validator only checks that `date` parses as ISO; doesn't sanity-check the value.
- **Direct file editing:** Removed from the skill. Agents always go through `PUT /api/tasks/:id` (or `POST /api/tasks` for creation). The validator-on-read still tolerates direct edits (auto-heal + reject malformed) but the skill no longer documents that path.

## Dependencies

- [[FLUX-287]] should land first — its normalizer becomes step 3's auto-heal.
- [[FLUX-288]] is independent but reduces the rate of new bad data while this ticket is in flight.
