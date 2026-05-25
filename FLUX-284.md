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
---

Subtask of FLUX-281.

## Problem / Motivation

The current "Launch Agent" UI is a flat dropdown that assumes one agent per ticket. The multi-agent architecture requires a pipeline-step model where users compose agents into orchestrated workflows with visibility into each session's status.

## Research Findings Informing This Ticket

**CLI capabilities the UI must expose:**
- CLI selection: Claude Code, Gemini CLI, Copilot CLI (each with different flags/capabilities)
- Mode selection: `plan` (read-only), `autopilot`/`acceptEdits` (full), background (`--bg` Claude only)
- Model override: `--settings '{"model":"..."}'` (Claude), `-m model` (Gemini), `--model model` (Copilot)

**Orchestration patterns the UI must support:**
1. **Relay Race:** Sequential pipeline — user selects ordered steps, each step is one agent role
2. **Scatter-Gather:** Parallel group + synthesis agent — user selects N parallel agents and 1 gatherer
3. **Supervisor:** Single lead agent with ability to spawn children — user selects the lead, children are dynamic

**Session states to display per agent card:**
- `pending` (queued in relay, waiting for barrier in scatter)
- `running` (active CLI process)
- `waiting` (paused via `--resume` pattern, awaiting input)
- `completed` (output captured, ready for next step)
- `failed` (non-zero exit or timeout)

**Per-session metadata to show:**
- Role label (e.g., "Security Reviewer", "Implementer")
- CLI type icon (Claude/Gemini/Copilot)
- Tool restrictions summary (e.g., "read-only", "full access")
- Token usage (from `--output-format json` metadata)

## Implementation Plan

1. Replace flat dropdown with pipeline builder component:
   - Step configurator: add/remove/reorder pipeline steps
   - Per step: select role, CLI type, orchestration position (parallel group or sequential)
   - Visual indicators for relay (arrows), scatter-gather (fan-out/fan-in), supervisor (tree)
2. Active agents panel per ticket:
   - Card per session showing: role, CLI, status badge, elapsed time, token count
   - Controls: stop, re-run, inspect output, attach (for `--resume` capable CLIs)
3. Pipeline templates: pre-built configurations for common workflows (e.g., "Standard Review" = Implementer → Pedant → QA)
4. Connect to extended session store API (`GET /api/tasks/:id/cli-sessions`)
