---
priority: Medium
effort: M
assignee: unassigned
tags:
  - agent-workflow
  - skills
  - ai
  - architecture
createdBy: Unknown
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-10T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-10T00:00:00.000Z'
    comment: >-
      Ticket created from session observation: ~1.5M input tokens accumulated,
      traced to static skill loading, verbose rules, and unfiltered API
      payloads. Four concrete improvement areas identified; grooming questions
      added for implementation direction before planning begins.
    id: c-2026-05-10t00-00-00-000z
  - type: activity
    user: Agent
    date: '2026-05-10T11:06:48.061Z'
    comment: Launched Claude Code session (63a6b04d).
  - type: activity
    user: Agent
    date: '2026-05-10T11:07:54.000Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-10T11:08:50.767Z'
    comment: Launched Claude Code session (a455bbbd).
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T11:10:01.769Z'
    comment: >-
      The tool seems to be failing. I'll ask directly: **Should API filtering be
      included here or tracked as a separate ticket?**


      My recommendation is a separate ticket — this ticket's highest ROI work
      (stripping the phase skills from the rules file) is self-contained and
      ready to plan now. API filtering is an engine code change with a different
      scope.


      While you decide, here's the plan I'd write regardless:


      ---


      **Implementation plan for PROJECT-2:**


      1. **Trim `.claude/rules/event-horizon.md`** — remove the `grooming`,
      `implementation`, and `release` `<skill_module>` blocks entirely. Keep
      only the orchestrator module with a condensed routing section. The three
      removed skills already live in `.docs/skills/` and are read on-demand.
      Estimated savings: ~190 lines / ~3,500 tokens per turn.


      2. **Update the orchestrator module** — add an explicit instruction
      telling the agent to read `.docs/skills/<phase>.md` on entry to each
      phase, so the on-demand loading is documented in the rules.


      3. **Prune orchestrator prose** — remove duplicated conventions that are
      already in the phase skill files (ticket editing conventions, comment
      conventions, working surfaces are repeated verbatim).


      4. **MEMORY.md pruning convention** — add a one-line note to MEMORY.md
      about keeping the index concise.


      5. **API filtering** — separate ticket if you agree, or added here.


      ---


      What's your call on the API filtering scope?
  - type: activity
    user: Agent
    date: '2026-05-10T11:10:22.232Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-10T13:41:56.008Z'
    comment: Launched Claude Code session (3c470df0).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T13:43:27.772Z'
  - type: activity
    user: Agent
    date: '2026-05-10T13:43:27.772Z'
    comment: Updated description.
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T13:43:32.378Z'
    comment: >-
      Ticket updated and moved to `Todo`. Grooming is complete.


      **Summary:**


      - **Scope decisions recorded:**
        - API filtering → separate ticket
        - Prompt caching → out of scope
        
      - **Plan written to ticket body** — 4 steps:
        1. Remove grooming/implementation/release `<skill_module>` blocks from the rules file (~3,200 tokens/turn savings)
        2. Add explicit on-demand loading instruction to the orchestrator Skill Routing section
        3. Orchestrator prose review (no removals needed — bulk savings are from Step 1)
        4. Add MEMORY.md pruning convention

      - **Status: Grooming → Todo**


      All four phase skills already exist in `.docs/skills/` so no content is
      lost by removing them from the rules file. Ready for implementation on
      your say-so.
  - type: activity
    user: Agent
    date: '2026-05-10T13:44:06.238Z'
    comment: Launched Claude Code session (8e51946c).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T13:44:26.655Z'
  - type: comment
    user: Agent
    date: '2026-05-10T13:44:26.655Z'
    comment: >-
      Starting implementation: removing phase skill bodies from rules file,
      adding on-demand loading instruction, and creating MEMORY.md with pruning
      convention.
    id: c-2026-05-10t13-44-26-655z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T13:45:10.957Z'
  - type: comment
    user: Agent
    date: '2026-05-10T13:45:10.957Z'
    comment: >-
      Implementation complete. Removed event-horizon-grooming,
      event-horizon-implementation, and event-horizon-release skill_module
      blocks from .claude/rules/event-horizon.md (309 → 121 lines, ~3,700
      tokens/turn savings). Updated Skill Routing table to explicitly instruct
      the agent to read the corresponding .docs/skills/<phase>.md file before
      starting work in each phase. Updated the ⚠️ DO NOT DELETE warning to
      reflect that only the orchestrator module lives here. Created
      /Users/guy/.claude/projects/-Users-guy-Event-Horizon/memory/MEMORY.md with
      a pruning convention note. The .docs/skills/ phase files are intact and
      unchanged. No engine or portal code was touched.
    id: c-2026-05-10t13-45-10-957z
  - type: activity
    user: Agent
    date: '2026-05-10T13:45:15.620Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-10T13:45:26.048Z'
    comment: Launched Claude Code session (e04cc73d).
  - type: status_change
    from: Ready
    to: Done
    user: Guy Banda
    date: '2026-05-10T14:00:00.000Z'
  - type: comment
    user: Guy Banda
    date: '2026-05-10T14:00:00.000Z'
    comment: >-
      Approved and closed. Rules file trimmed from 309 → 121 lines (~3,700
      tokens/turn savings). MEMORY.md pruning convention in place.
    id: c-2026-05-10t14-00-00-000z
  - type: activity
    user: Agent
    date: '2026-05-10T13:46:21.725Z'
    comment: Claude Code session ended with code 0.
title: Reduce per-turn token cost of the agent workflow
status: Done
implementationLink: 'PROJECT-2: reduce per-turn token cost via rules file trimming'
tokenMetadata:
  inputTokens: 584289
  outputTokens: 8568
  costUSD: 0.514723
  costIsEstimated: false
---
## Implementation Plan

### Scope

This ticket addresses opportunities 1, 3, and 4 from the original analysis. Opportunities 2 (prompt caching) and 5 (API filtering) are explicitly out of scope — they require a separate investigation and engine code change respectively.

---

### Step 1 — Remove phase skill bodies from the rules file

**File:** `.claude/rules/event-horizon.md`

Delete the three non-orchestrator `<skill_module>` blocks entirely:
- `event-horizon-grooming`
- `event-horizon-implementation`
- `event-horizon-release`

These already live in `.docs/skills/` and are read on-demand when the agent enters each phase. Removing them saves ~160 lines (~3,200 tokens) from every turn.

**Validation:** Count lines before/after. Confirm `.docs/skills/` files are intact and unchanged.

---

### Step 2 — Add on-demand loading instruction to the orchestrator module

**File:** `.claude/rules/event-horizon.md` (orchestrator `<skill_module>` block)

In the Skill Routing section, add an explicit instruction: before starting work in a phase, read the corresponding `.docs/skills/<file>.md` to load the full skill instructions. This ensures the on-demand loading contract is documented in the always-present rules, not just implied.

Also update the `⚠️ DO NOT DELETE` warning — it currently claims that all four phase skill files are required in this rules file, which will no longer be true.

---

### Step 3 — Prune duplicated orchestrator prose

**File:** `.claude/rules/event-horizon.md` (orchestrator `<skill_module>` block)

The orchestrator currently repeats content that belongs only in the phase skill files:
- `## Ticket Model` — keep; it is genuinely orchestrator-level reference.
- `## Working Surfaces` — keep.
- `## Available APIs` — keep.
- `## User Input Routing` — keep; governs cross-phase routing decisions.
- `## End-to-End Checklist` — keep; this is the orchestrator-level quality gate.

No sections need to be removed from the orchestrator itself — the bulk of the savings comes from Step 1. Only tighten prose where sentences are redundant or wordy.

---

### Step 4 — Add MEMORY.md pruning convention

**File:** `/Users/guy/.claude/projects/-Users-guy-Event-Horizon/memory/MEMORY.md`

Add a brief note at the top of the index reminding the agent to keep entries concise and prune stale or redundant memories. This prevents unbounded MEMORY.md growth from compounding the per-turn baseline over time.

---

### Out of Scope

- **Prompt caching (opportunity 2):** Does not reduce the visible token counter; requires investigation into where Claude Code injects cache-control headers. Separate work.
- **API filtering (opportunity 5):** Engine code change (`GET /api/tasks` query params). Track as a separate ticket.
- Changing the ticket data model
- Altering the portal UI

---

### Validation

1. Line count of `.claude/rules/event-horizon.md` reduced by ~160 lines.
2. `.docs/skills/event-horizon-grooming.md`, `event-horizon-implementation.md`, `event-horizon-release.md` are unchanged.
3. Engine still starts and serves tickets correctly after rules file edit.
4. Grooming a test ticket works end-to-end (reads phase skill from `.docs/skills/`).
 the per-turn baseline over time.

---

### Out of Scope

- **Prompt caching (opportunity 2):** Does not reduce the visible token counter; requires investigation into where Claude Code injects cache-control headers. Separate work.
- **API filtering (opportunity 5):** Engine code change (`GET /api/tasks` query params). Track as a separate ticket.
- Changing the ticket data model
- Altering the portal UI

---

### Validation

1. Line count of `.claude/rules/event-horizon.md` reduced by ~160 lines.
2. `.docs/skills/event-horizon-grooming.md`, `event-horizon-implementation.md`, `event-horizon-release.md` are unchanged.
3. Engine still starts and serves tickets correctly after rules file edit.
4. Grooming a test ticket works end-to-end (reads phase skill from `.docs/skills/`).
re unchanged.
3. Engine still starts and serves tickets correctly after rules file edit.
4. Grooming a test ticket works end-to-end (reads phase skill from `.docs/skills/`).
