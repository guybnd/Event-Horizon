---
title: Engine-level prompt optimizations for input token reduction
status: Backlog
priority: Medium
effort: M
assignee: unassigned
tags:
  - engine
  - performance
createdBy: Agent
updatedBy: Guy
relatedTickets:
  - FLUX-208
history:
  - type: activity
    user: Agent
    date: '2026-05-14T09:33:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-14T09:33:00.000Z'
    comment: Created as follow-up from FLUX-208 (L4 deferred scope).
  - type: status_change
    from: Grooming
    to: Backlog
    user: Guy
    date: '2026-05-24T13:25:51.788Z'
---

## Problem / Motivation

FLUX-208 reduced token costs at the skill/instruction layer. Further savings are possible at the engine level — in `buildInitialPrompt()` and how skills are loaded for non-modular frameworks. These changes involve engine source modifications rather than just file content.

## Implementation Plan

### 4a. Phase-aware prompt injection
Instead of the agent making 2–3 file read tool calls (orchestrator + phase skill), `buildInitialPrompt()` in `engine/src/agents/copilot.ts` could inject a pre-computed minimal instruction block based on ticket status. Eliminates tool-call overhead and redundant file reads.

Trade-off: couples engine to skill content — harder to maintain independently.

### 4b. Smarter history filtering
Currently sends last 3 history entries, filtering `agent_message` type. Could also:
- Filter out `status_change` entries (current status is already stated)
- Only include the latest `comment` entry for grooming tickets
- Make history depth configurable per ticket phase

### 4c. Non-modular framework phase header
`buildConcatenatedSkill()` bundles all 4 modules into XML tags. Add a header instructing the agent to only process the `<skill_module>` matching the current ticket phase, reducing effective token usage for Gemini/Cursor/Windsurf.
