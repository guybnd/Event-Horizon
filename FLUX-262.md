---
id: FLUX-262
title: Two-tier instruction architecture for zero-cost non-ticket interactions
status: Grooming
priority: Low
effort: L
assignee: unassigned
tags:
  - workflow
  - performance
createdBy: Agent
updatedBy: Agent
relatedTickets:
  - FLUX-208
  - FLUX-261
history:
  - type: activity
    user: Agent
    date: '2026-05-14T09:33:00.000Z'
    comment: Created as follow-up from FLUX-208 (L6 deferred scope).
---

## Problem / Motivation

Even after FLUX-208's optimizations, the always-on instructions (~430 tokens) load on every interaction including pure chat, brainstorming, and code reviews that don't touch tickets. A two-tier architecture could reduce non-ticket overhead to near zero while keeping full ticket workflow support.

## Implementation Plan

### 6a. Two-tier instruction architecture
- **Tier 1 (always-on, ~100 tokens):** "This repo uses Event Horizon. Tickets in `.flux/`. When working on a ticket, read the orchestrator skill."
- **Tier 2 (on-demand, loaded per-ticket):** Orchestrator + one phase skill (as today).

This means non-ticket interactions pay almost nothing, while ticket work self-loads full context.

Requires: validating that agents reliably self-load tier 2 when they detect ticket work. Risk of agents skipping skill loading needs testing across Copilot, Gemini, Cursor.

### 6b. Prompt caching alignment
For models with prompt caching (Claude, GPT), ensure static instruction content sits at the beginning of the context window to maximize cache hits. Investigate whether skill content injected by the engine (FLUX-261 4a) would be more cacheable than agent-loaded file reads.
