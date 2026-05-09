---
assignee: unassigned
tags:
  - integration
  - agent
  - workflow
  - architecture
  - research
priority: Medium
effort: XL
implementationLink: e092f09
subtasks:
  - >-
    Add engine-managed CLI session lifecycle for ticket launch, streaming
    output, and completion states
  - >-
    Add ticket-level actions to launch Claude Code and Copilot CLI directly from
    Event Horizon
  - >-
    Persist agent responses into ticket comments and support ticket-comment
    replies back into active CLI sessions
  - Expose active session state in board and ticket views
  - 'Document CLI integration setup, limits, and expected workflow in .docs'
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:20:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Claude Code
    date: '2026-05-09T04:20:00.000Z'
    comment: >-
      Shipped in commit e092f09. Engine-side CLI session manager with full
      lifecycle tracking (running/completed/failed/cancelled), REST endpoints
      for start/input/stop/status, stream-json output parsing that flushes
      assistant text to ticket history as comments, reply routing via --resume
      <session-id>, and portal UI with Launch button, active session indicator,
      live polling every 2.5s, and TaskCard green border + pulsing ring while
      agent is running. Both engine and portal builds validated. Follow-on work
      (block detection, max permissions flag, context menu launcher) tracked
      under FLUX-134 and FLUX-135.
    id: c-2026-05-09t04-20-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:20:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:17:38.799Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:17:38.799Z'
    comment: Updated implementation link.
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:17:42.433Z'
    comment: >-
      ```text

      FLUX-132 is closed. Commit `e092f09` is recorded as the implementation
      link, a completion comment summarises what shipped, and the ticket moved
      to Done.

      ```
    id: c-2026-05-08t14-17-42-433z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.343Z'
title: two way integration with CLIs like claude code and copilot CLI
status: Released
createdBy: Guy
updatedBy: Agent
order: 1
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.343Z'
releaseDocPath: release-notes/0.2.0
---
## Problem / Motivation

Event Horizon can already install workflow instructions into agent-specific
surfaces such as GitHub Copilot and Claude Code, but that is still mostly a
one-way setup step. The missing piece is a real execution loop where external
CLI agents can be launched against a ticket, consume the ticket context, and
report progress back so the board reflects active agent work instead of acting
only as a static prompt source.

The reference direction from Vibe Kanban suggests a tighter plan/prompt/review
loop: pick a ticket, launch or target a coding agent, then let ticket status,
comments, and review state move as the agent works. That would make Event
Horizon more useful as the control plane for parallel agent sessions rather than
just the place where workflow rules are installed.

## Implementation plan

1. Reuse the existing workflow-install surface for agent-specific setup rather
   than creating a second install path. The current `workflow-installer.ts` and
   Settings workflow selector already support Copilot and Claude targets.
2. Implement a ticket-scoped launcher for Claude Code and Copilot CLI from the
  Event Horizon UI so users can start agent work without switching tools.
3. Define and persist a session lifecycle in the engine:
  - pending -> running -> waiting-input -> completed/failed/cancelled
  - session metadata: ticket id, framework, command, cwd/worktree, pid,
    startedAt, endedAt, agent label
4. Stream session outputs into ticket history as structured comments so agent
  responses are visible directly in the ticket timeline.
5. Add reply routing from ticket comments back into the running CLI session so
  users can continue the conversation from Event Horizon.
6. Surface active session state in board and ticket UI so a card clearly shows
  when a bot is actively working.
7. Add failure and recovery behavior:
  - process exits unexpectedly -> add failure activity + status hint
  - no active session for a reply -> keep comment local and mark as not sent
  - optional manual retry/cancel controls
8. Validate with focused end-to-end checks for both CLIs:
  - launch from ticket
  - observe running indicator
  - agent output lands as comments
  - ticket reply is delivered to session
  - session completion/failure updates timeline state
9. Update docs for setup, usage flow, and known constraints (local process,
  environment requirements, and safety caveats).

## Scope decisions from grooming

- First slice is the full wrapper/launcher workflow from inside Event Horizon.
- Bidirectional communication is required in slice one, but via Event Horizon
  session orchestration and comment routing, not an external MCP dependency.
- Initial target CLIs are Claude Code and Copilot CLI.

## Likely touchpoints

- `engine/src/index.ts`
- `portal/src/components/TaskCard.tsx`
- `portal/src/components/TaskModal.tsx`
- `portal/src/api.ts`
- `.docs/event-horizon/workflow/`

## Follow-on / related work

- FLUX-6 remains the likely follow-on for a deeper MCP-style protocol surface
  after the in-product wrapper flow is stable.
