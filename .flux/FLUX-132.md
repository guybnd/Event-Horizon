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
implementationLink: ''
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
    date: '2026-05-08T11:52:29.447Z'
    comment: Created ticket.
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T11:56:13Z'
    comment: >-
      Groomed this into a concrete integration proposal. Event Horizon already
      supports one-way workflow installation for Copilot and Claude Code, but a
      true two-way CLI integration could mean either a lightweight wrapper that
      launches agent CLIs and watches ticket/git changes, or a deeper runtime
      bridge (likely MCP/API-backed) that lets those CLIs read active ticket
      context and push status/comments back. Proposed default: start with the
      lightweight wrapper flow for Claude Code and Copilot CLI first, then add a
      richer protocol bridge later if it proves necessary. Do you want this
      ticket scoped as (A) wrapper/launcher integration first, or (B) direct
      bidirectional protocol integration first?
    id: c-2026-05-08t11-56-13z
  - type: status_change
    from: Grooming
    to: Require Input
    user: GitHub Copilot
    date: '2026-05-08T11:56:13Z'
  - type: comment
    user: Guy
    date: '2026-05-08T11:58:25.122Z'
    comment: >-
      basically i want to be able to :



      launch a task to the respective CLI from the interface of a ticket here


      see that its currently being worked on by the bot


      receive the response from the bot as a comment in the ticket, respond in
      the ticket to communicate directly to the bot CLI


      without having to go and open the IDE and paste messages etc. seamless
      full workflow from the event horizon
    replyTo: c-2026-05-08t11-56-13z
    id: c-2026-05-08t11-58-25-122z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-08T11:58:25.122Z'
    comment: Response submitted
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T12:00:41Z'
    comment: >-
      Grooming updated from your response. Scope is now a seamless in-ticket
      loop: launch Claude Code/Copilot CLI from the ticket UI, show active agent
      working state on the ticket, ingest agent output as ticket comments, and
      allow reply comments to flow back to the running CLI session without
      leaving Event Horizon. Marking as Todo with this concrete plan.
    id: c-2026-05-08t12-00-41z
  - type: status_change
    from: Grooming
    to: Todo
    user: GitHub Copilot
    date: '2026-05-08T12:00:41Z'
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T12:10:44Z'
    comment: >-
      Starting implementation in vertical slices: (1) engine-side CLI session
      manager and REST endpoints to launch/send/stop/list ticket-bound sessions,
      (2) portal API wiring, (3) ticket modal controls for launch and live
      status, (4) route ticket replies to active sessions and append agent
      output as comments. First pass targets Claude Code and Copilot CLI.
    id: c-2026-05-08t12-10-44z
  - type: status_change
    from: Todo
    to: In Progress
    user: GitHub Copilot
    date: '2026-05-08T12:10:44Z'
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T12:17:08Z'
    comment: >-
      Implemented first vertical slice: engine task-scoped CLI session APIs
      (start/input/stop/status), session lifecycle tracking, and ticket-history
      sync for agent output; added portal API bindings and Task Modal controls
      to launch Claude/Copilot sessions and route comments/replies into active
      sessions. Validation: engine build passes. Portal build currently fails in
      third-party type declarations under node_modules (csstype/re-resizable
      parse errors), so this slice is kept In Progress until we decide whether
      to patch dependency state or validate via dev runtime only.
    id: c-2026-05-08t12-17-08z
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T12:19:51Z'
    comment: >-
      Resolved the validation blocker by reinstalling dependencies through a
      workspace-local npm cache, then fixed one TaskModal typing issue in the
      new CLI session polling effect. Validation now passes for both portal and
      engine builds.
    id: c-2026-05-08t12-19-51z
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T12:21:10Z'
    comment: >-
      Added board-level active bot visibility by surfacing task cliSession data
      on task cards, plus initial CLI session refresh when opening a ticket.
      Revalidated portal and engine builds after these UI updates.
    id: c-2026-05-08t12-21-10z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:17:00.000Z'
    comment: >-
      ## Two-Way CLI Integration — How It Works


      ### Session Launch

      When the user clicks **Launch** in the ticket modal, the portal calls
      `POST /api/tasks/:id/cli-session/start`. The engine builds an initial
      prompt from the ticket title, body, and last six history entries, then
      spawns `claude -p <prompt> --output-format stream-json --verbose` via Node
      `spawn()`. The session is registered in two in-memory maps and assigned
      status `running`. A launch activity is written to ticket history so the
      timeline records the start time.


      ### Output → Ticket History

      The engine attaches a `stdout` listener to the spawned process. Because
      `--output-format stream-json` is used, Claude Code emits newline-delimited
      JSON. Each line is parsed: when the event type is `assistant`, the engine
      extracts text blocks from `message.content`, buffers them on the session
      record, and flushes to ticket history as a comment every 1 second
      (debounced). The flush calls `updateTaskWithHistory`, which rewrites the
      `.flux/*.md` file. The chokidar watcher picks up the change, updates the
      in-memory task cache, and the comment is visible on the next portal poll.


      ### Reply → CLI Session

      When the user submits a comment while a session is active, the portal
      routes it to `POST /api/tasks/:id/cli-session/input` instead of the normal
      comment path. The engine captured the `session_id` from the stream-json
      output during the initial run. Follow-up messages are delivered by
      spawning `claude -p <message> --resume <session-id> --output-format
      stream-json --verbose`, which continues the same conversation thread. The
      user message is also written to ticket history so the full exchange is
      visible in the timeline.


      ### UI Live State

      The ticket modal polls `GET /api/tasks/:id/cli-session` every 2.5 seconds
      while active, refreshing session state and triggering a full task reload
      so new history comments appear. The board card reflects active state
      independently: every task in `GET /api/tasks` includes a `cliSession`
      summary injected at serialisation time, so cards show a **green border +
      pulsing ring + bot label** without a separate request. When the process
      exits, the engine writes an activity entry with the exit code, marks the
      session `completed` or `failed`, and the next poll clears the active
      indicators.
    id: c-2026-05-08t13-17-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-08T14:12:16.276Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:13:31.223Z'
    comment: Launched Claude Code session (a6a47e87).
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:13:42.952Z'
    comment: >-
      ```text

      Let me check the current state of the ticket and changed files before
      closing.

      ```
    id: c-2026-05-08t14-13-42-952z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:14:12.128Z'
    comment: >-
      ```text

      Let me look at the actual diffs to separate FLUX-132 changes from other
      tickets' work.

      ```
    id: c-2026-05-08t14-14-12-128z
title: two way integration with CLIs like claude code and copilot CLI
status: Ready
createdBy: Guy
updatedBy: Agent
order: 1
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
