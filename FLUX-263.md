---
title: Filter noisy stderr from agent CLI sessions
status: Backlog
priority: Medium
effort: S
assignee: unassigned
tags:
  - engine
  - quality
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-14T09:42:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-14T09:42:00.000Z'
    comment: >-
      Created from observed Gemini CLI session output showing full 429 stack
      traces and deprecation warnings polluting liveOutputBuffer.
  - type: status_change
    from: Grooming
    to: Backlog
    user: Guy
    date: '2026-05-18T13:52:52.345Z'
---

## Problem / Motivation

Agent CLI sessions (especially Gemini) dump verbose transient errors to stderr — full 429 rate-limit stack traces (~2KB each), Node deprecation warnings, and "Ripgrep not available" messages. These are all handled internally by the CLI and don't affect session outcomes, but they pollute `liveOutputBuffer` and ticket history with kilobytes of noise per session. Makes portal session output harder to read.

## Implementation Plan

Extend the existing stderr noise filter in `engine/src/agents/copilot.ts:48-53` (shared via `appendSessionOutput`) to also suppress or condense:

- **429 / rate-limit / capacity exhausted** → condense to one-liner: `[retry] API rate-limited, retrying...`
- **DEP0190 deprecation warning** → suppress entirely (informational, not actionable at runtime)
- **"Ripgrep is not available"** → suppress entirely (Gemini CLI fallback, not our concern)

Touchpoints: `engine/src/agents/copilot.ts` (`appendSessionOutput` function).
