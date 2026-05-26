---
assignee: unassigned
tags:
  - feature
  - multi-agent
  - workflow
priority: High
effort: L
implementationLink: ''
subtasks:
  - FLUX-282
  - FLUX-283
  - FLUX-284
  - FLUX-285
  - FLUX-311
history:
  - type: activity
    user: Guy
    date: '2026-05-24T13:09:31.169Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-24T13:10:13.309Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-24T13:15:23.381Z'
    comment: Updated description.
  - type: agent_session
    sessionId: f5fb9e24-ad19-44de-a200-175212670126
    startedAt: '2026-05-24T13:19:06.988Z'
    status: cancelled
    progress: []
    user: Gemini CLI
    date: '2026-05-24T13:19:06.988Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T04:24:30.462Z'
  - type: status_change
    user: Gemini CLI
    date: '2026-05-24T13:20:00.000Z'
    from: Grooming
    to: Todo
  - type: status_change
    user: Guy
    date: '2026-05-24T13:45:12.215Z'
    from: Todo
    to: Grooming
  - type: comment
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    comment: >-
      Groomed ticket. Incorporated three orchestration patterns (Relay Race,
      Scatter-Gather, Supervisor) from user input. Rewrote implementation plan
      to map patterns to phases, define the pipeline-step UI model, and align
      with existing subtasks FLUX-282 through FLUX-285.
    id: c-2026-05-24t14-00-00-000z
  - type: status_change
    user: Agent
    date: '2026-05-24T14:00:00.000Z'
    from: Grooming
    to: Todo
title: multi agent code review
status: Todo
createdBy: Guy
updatedBy: Guy
order: 1
---

## Problem / Motivation

Event Horizon currently enforces a one-session-per-ticket model. Agents act as generalists — the same session grooms, implements, and reviews. This limits quality: a reviewer sharing context with an implementer can hallucinate implementation details, and parallel information-gathering (e.g., scanning code while interrogating specs) is impossible. Users need the ability to launch multiple specialized agent sessions per ticket, orchestrated through defined patterns, so that each phase (Grooming, Execution, Validation) benefits from focused, context-isolated roles running across Claude, Gemini, and Copilot CLIs.

## Orchestration Patterns

Three coordination patterns govern how agents interact:

### 1. Relay Race (Sequential Chaining)
Agents trigger one after another. Output of Agent A is wrapped into the prompt for Agent B. Best for the **Validation/Review** phase where order matters (e.g., Implementer → Pedant → QA Automator).

### 2. Scatter-Gather (Parallel with Blocking Merge)
Multiple agents launch simultaneously on non-overlapping work. A synthesis agent is blocked until all parallel agents return. Best for **Grooming** and **Execution** phases (e.g., Interrogator + Context Scout run in parallel → Spec Writer synthesizes).

### 3. Supervisor (Dynamic Handoff)
A lead agent is assigned to a phase and can invoke other roles as tools on-demand. Best for **ambiguous tasks** where the critical path is unknown upfront (e.g., Lead Architect calls Context Scout for schema info, then decides next step).

## Implementation Plan

### Step 1: CLI Capability Research → FLUX-282
- Document system-prompt injection methods for each CLI (Claude `--system-prompt`/rules files, Gemini `--system-instruction`, Copilot custom instructions).
- Document context isolation techniques: what each CLI passes between invocations vs. what is ephemeral.
- Produce a compatibility matrix: which orchestration patterns each CLI supports natively vs. needs engine-level coordination.

### Step 2: Session Orchestration Layer → FLUX-283
- Refactor `session-store.ts` from 1-to-1 (`cliSessionIdByTaskId` map) to 1-to-many (array of sessions per task, each tagged with role + pattern position).
- Implement orchestration primitives:
  - **Relay**: Sequential queue with output-forwarding between sessions.
  - **Scatter-Gather**: Parallel session group with a barrier that blocks the synthesis session until all gather-agents complete.
  - **Supervisor**: A session that can spawn child sessions and receive their output as tool-call results.
- Add file-locking conventions: sessions declare which paths they intend to write; engine rejects conflicting launches.
- Update `routes/cli-session.ts` to remove the 409 single-session guard and add multi-session endpoints (`GET /:id/cli-sessions`, launch with `role` + `pattern` params).

### Step 3: Portal UI — Pipeline Builder → FLUX-284
- Replace the flat "Launch Agent" dropdown with a pipeline-step model:
  - Step 1: Select parallel gathering agents (Scatter).
  - Step 2: Select synthesis/lead agent (Gather or Supervisor).
  - Step 3: Select validation/review agents (Relay).
- Show active agent cards per ticket: role label, CLI type, status (pending/running/waiting/completed), token usage.
- Add controls to stop, re-run, or inspect output of individual sessions in the pipeline.

### Step 4: Agent Role Definitions → FLUX-285
- Create role prompt templates (stored in `.flux/skills/roles/` or engine config):
  - **Grooming (4):** Interrogator, Architect, Scopesmith, Spec Writer.
  - **Execution (4):** Context Scout, Implementer, Refactorer, Dependency Manager.
  - **Validation (5):** Pedant, Product Proxy, QA Automator, Auditor, Documenter.
- Each template specifies: role identity, allowed actions, context boundaries (what it can/cannot see), output format contract.
- Define hand-off contracts: what structured output each role produces that the next role consumes.

### Step 5: Coordination & Hand-off Guidelines
- Document the recommended pattern for each phase (Scatter-Gather for Grooming, Relay for Review, Supervisor for bug-fixing).
- Define output schemas for inter-agent payloads (so a Spec Writer's output is machine-parseable by QA Automator).
- Establish conflict-resolution rules: if two agents produce contradictory changes, the Supervisor or user arbitrates.
