---
id: FLUX-284
title: Implement role-selection UI in portal dropdown
status: Todo
priority: High
effort: M
assignee: unassigned
tags:
  - feature
  - multi-agent
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: Auto-created from inline subtask of FLUX-281.
  - type: activity
    user: Agent
    date: '2026-05-25T11:45:03.591Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Updated ticket body with research findings from FLUX-282. Added: CLI
      capabilities the UI must expose (mode selection, model override,
      background), orchestration pattern visualizations needed
      (relay/scatter-gather/supervisor), session states to display, and
      per-session metadata from JSON output. Implementation plan now covers
      pipeline builder, active agents panel, and templates.
    date: '2026-05-25T11:45:16.693Z'
    id: c-2026-05-25t11-45-16-693z
  - type: activity
    user: Agent
    date: '2026-05-25T11:49:13.403Z'
    comment: Updated description.
---

Subtask of FLUX-281.

## Problem / Motivation

The current "Launch Agent" UI is a flat dropdown that assumes one agent per ticket. The multi-agent architecture requires a pipeline-step model where users compose agents into orchestrated workflows with visibility into each session's status.

**Design principle: Claude-first.** The UI defaults to Claude Code as the CLI. Gemini/Copilot are selectable but secondary — the happy path should require zero CLI-type configuration (just pick roles and go).

## Research Findings Informing This Ticket

**Default experience (Claude Code):**
- All orchestration patterns work: relay, scatter-gather, supervisor
- All session states are valid: pending, running, waiting (via `--resume`), completed, failed
- Background mode (`--bg`) enables non-blocking parallel execution
- No special model config needed — inherits from project settings

**Capability-aware UI constraints:**
- Gemini sessions will never show "waiting" state (no resume) — hide that status
- Gemini cannot be assigned as Supervisor lead — disable that option in role picker
- Copilot's BYOK mode (can use Claude models) is a power-user feature — hide behind advanced toggle
- Background mode toggle only relevant for Claude — hide for others

**Per-session metadata available from `--output-format json`:**
- Token usage (input/output/cache)
- Model used
- Duration
- Tool calls made
- Structured result

## Implementation Plan

1. Replace flat dropdown with pipeline builder component:
   - Default: Claude Code, no CLI picker shown unless user expands "Advanced"
   - Step configurator: add/remove/reorder pipeline steps
   - Per step: select role (required), CLI type (optional, defaults to Claude), orchestration position
   - Visual indicators for relay (arrows), scatter-gather (fan-out/fan-in), supervisor (tree)
2. Active agents panel per ticket:
   - Card per session showing: role, CLI type icon, status badge, elapsed time, token count
   - Controls: stop, re-run, inspect output, attach/resume (only shown for Claude/Copilot sessions)
   - Gemini cards show subset of controls (no attach/resume)
3. Capability-aware controls:
   - CLI selection conditionally enables/disables pattern options and session actions
   - Invalid combinations prevented at UI level (greyed out with tooltip explaining why)
   - Status badges filtered to possible states per CLI type
4. Pipeline templates: pre-built configurations for common Claude-based workflows:
   - "Quick Review" = single Pedant session
   - "Standard Review" = Implementer → Pedant → QA Automator (relay)
   - "Deep Grooming" = Interrogator + Architect (scatter) → Spec Writer (gather)
5. Connect to extended session store API (`GET /api/tasks/:id/cli-sessions`)
