---
assignee: unassigned
tags:
  - workflow
  - performance
priority: High
effort: L
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T05:14:26.638Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-14T09:10:00.000Z'
    comment: >-
      Full audit complete. Identified ~7,000 tokens of pure duplication across
      skill files, ~3,300 tokens wasted from double copilot-instructions, and
      variable 2K-15K waste from blanket doc reads. Grooming into L1-L3 + L5
      optimization plan (eliminate waste, restructure instructions, smart doc
      loading, prose compression). L4/L6 deferred.
    id: c-2026-05-14t09-10-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-14T09:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-14T09:22:00.000Z'
    comment: >-
      Implementation complete. Deleted SKILL.md (12KB redundant), deprecated
      agent.md (12.6KB), fixed doubled copilot-instructions (13KB→1.7KB),
      compressed all 4 skill files by ~50%, created INDEX.md for targeted doc
      reads, added effort-gated doc loading. Total: ~93% reduction in always-on
      overhead, ~60% reduction in per-ticket skill tokens.
    id: c-2026-05-14t09-22-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-14T09:22:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-14T09:37:00.000Z'
    comment: >-
      Committed as 14e8424. 13 files changed, 215 insertions, 909 deletions.
      Follow-up tickets FLUX-261 (engine optimizations) and FLUX-262 (two-tier
      architecture) created.
    id: c-2026-05-14t09-37-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-14T09:37:00.000Z'
title: Minimize input token costs across skill and instruction files
status: Done
implementationLink: '14e8424'
createdBy: Guy
updatedBy: Agent
order: 4
---

## Problem / Motivation

Every ticket interaction consumes ~25,000–35,000 input tokens before the agent reads any implementation code. This is driven by massive content duplication across the instruction stack (the same workflow steps appear 3×, the ticket model 2×), a literally doubled `copilot-instructions.md`, and blanket `.docs/` reads regardless of relevance. The cost scales with every ticket interaction across every workspace.

## Implementation Plan (L1–L3 + L5)

### Layer 1: Eliminate Pure Waste (~6,400–9,600 token savings)

**1a. Fix copilot-instructions.md duplication**
- Lines 76–140 of the installed file are an identical stale copy below the managed block
- Fix the source template and re-run installer

**1b. Delete SKILL.md**
- Every section is already in orchestrator.md + phase skills
- Remove `.github/skills/event-horizon/SKILL.md`
- Update copilot-instructions source to remove "Source Of Detailed Procedure" reference

**1c. Delete deprecated event-horizon-agent.md**
- Remove `.flux/skills/event-horizon-agent.md` (12.6KB, marked deprecated)

### Layer 2: Restructure Instruction Hierarchy (~2,000–3,000 token savings)

**2a. Slim copilot-instructions.md to ~25-line thin router**
- Keep only: scope, ticket resolution, routing pointer to orchestrator, critical safety rules
- Remove: full 15-step workflow (already in phase skills), commit rules (in implementation.md), doc expectations (in grooming.md)

**2b. Deduplicate phase skills vs orchestrator**
- Phase skills should only contain phase-specific workflow + conventions
- Add one-liner pointing to orchestrator for ticket model/API reference
- Remove repeated editing conventions, file safety, comment conventions from phase skills

### Layer 3: Smart Doc Loading (~2,000–15,000 token savings)

**3a. Create `.docs/INDEX.md` topic map (~500 bytes)**
- Maps topic keywords to specific doc files
- Instructions change from "read `.docs/`" to "read INDEX.md, then only relevant files"

**3b. Effort-gated doc reads**
- XS/S tickets: skip `.docs/` entirely
- M+ tickets: read INDEX.md → relevant files only

### Layer 5: Prose Compression (~1,500–2,000 token savings)

**5a. Tighten all skill file prose by 30–40%**
- LLMs follow terse instructions equally well
- Example: "If unresolved, do not silently pick a direction. Move the ticket to the configured user-input status..." → "Unresolved → move to Require Input, post one question with proposed defaults, wait."

### Deferred (follow-up tickets)

- **L4**: Engine-level prompt injection, smart history filtering
- **L6**: Two-tier instruction architecture, prompt caching alignment

## Projected Savings

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| Non-ticket interaction | ~6,600 tokens | ~500 tokens | **~92%** |
| Ticket (conservative) | ~25,000 tokens | ~10,000–12,000 | **~50–60%** |
| Ticket (with smart doc loading) | ~35,000 tokens | ~8,000–12,000 | **~60–75%** |
