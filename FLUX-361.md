---
priority: High
effort: M
tags:
  - portal
  - refactor
  - agent
title: Unify agent-launch entry points across card and modal
status: In Progress
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-06-03T04:38:33.772Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T04:38:45.498Z'
  - type: comment
    comment: >-
      Starting. Order: 1) create portal/src/agentActions.ts with single
      registries (EFFORT_LEVELS, AGENT_COMMANDS, REVIEW_PERSONAS) and a pure
      runAgentAction(api) helper. 2) Expose runAgentAction from AppContext so
      all sites get one error/refresh path. 3) Rewire ContextMenu, TaskModal
      handlers, useCliSession.launchSession. 4) Add persona picker to
      ContextMenu Review. 5) Verify only call site of startTaskCliSession is
      inside agentActions.
    user: Agent
    date: '2026-06-03T04:38:45.498Z'
    id: c-2026-06-03t04-38-45-498z
  - type: status_change
    from: In Progress
    to: Done
    user: copilot
    date: '2026-06-03T04:43:06.136Z'
  - type: activity
    user: copilot
    date: '2026-06-03T04:43:06.136Z'
    comment: Updated implementation link.
  - type: comment
    user: copilot
    comment: >-
      Refactor landed in commit 17a6bcc.


      New module `portal/src/agentActions.ts` exports the shared registries
      (EFFORT_LEVELS, AGENT_COMMANDS, REVIEW_PERSONAS) and a single
      `runAgentAction({taskId, framework, action, currentUser, skipPermissions?,
      effortOverride?, preStatus?})` function that wraps `startTaskCliSession`
      plus the optional pre-launch `updateTask({status})`.


      Rewired callers:

      - `portal/src/hooks/useCliSession.ts` launchSession ->
      runAgentAction({kind:'launch'})

      - `portal/src/components/TaskModal.tsx` handleGrooming / sendFinishCommand
      / handleSendForCodeReview -> runAgentAction

      - `portal/src/components/ContextMenu.tsx` handleLaunchAgent /
      handleAgentCommand / handleSendForGrooming -> runAgentAction; new Code
      Review submenu wired to REVIEW_PERSONAS

      - `portal/src/components/TaskCard.tsx` sendFinishCommand /
      sendStatusAction / sendReview -> runAgentAction

      - `portal/src/components/LaunchAgentSplitButton.tsx` imports EFFORT_LEVELS
      from agentActions (dedupe)


      Fixes shipped:

      1. TaskModal sendFinishCommand was dropping the user-toggled
      skipPermissions flag; now forwarded.

      2. Card Code Review now opens a persona picker matching the modal
      (previously sent a bare 'review <id>' with no persona).

      3. Card status-action verb unified to 'implement <id>' (was 'do <id>').

      4. Card Send-for-Grooming no longer pre-moves status; the agent owns the
      Grooming transition itself (matches modal behavior).


      Verification:

      - grep startTaskCliSession portal/src shows only api.ts (definition) and
      agentActions.ts (single caller).

      - cd portal && npm run build succeeds: 2518 modules transformed in 509ms,
      zero TS errors.
    date: '2026-06-03T04:43:06.136Z'
    id: c-2026-06-03t04-43-06-136z
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-06-03T04:49:05.672Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-06-03T04:49:10.431Z'
  - type: agent_session
    sessionId: c79ee7b9-7294-4587-9bc3-fd652c6c0965
    startedAt: '2026-06-03T04:49:10.459Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T04:49:20.844Z'
        message: 'Running: git log --oneline -10'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git log --oneline -10
            description: Show recent git log
      - timestamp: '2026-06-03T04:49:25.519Z'
        message: Running command
        type: info
      - timestamp: '2026-06-03T04:49:28.025Z'
        message: Reading agentActions.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/agentActions.ts
      - timestamp: '2026-06-03T04:49:28.744Z'
        message: 'Running: git diff HEAD~1 HEAD -- portal/src/ 2>&1 | wc -l'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git diff HEAD~1 HEAD -- portal/src/ 2>&1 | wc -l
            description: Check total diff size
      - timestamp: '2026-06-03T04:49:40.521Z'
        message: Running command
        type: info
      - timestamp: '2026-06-03T04:49:45.108Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__add_comment,mcp__event-horizon__change_status
            max_results: 2
      - timestamp: '2026-06-03T04:49:55.520Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:50:10.521Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T04:50:23.441Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__add_comment
          parameters:
            ticketId: FLUX-361
            comment: >-
              Code review — Linus mode.


              The goal was met: `grep startTaskCliSession portal/src` shows only
              `api.ts` and `agentActions.ts`. `skipPermissions` is now forwarded
              in `sendFinishCommand`. Grooming no longer pre-moves status from
              the card. Persona picker works from the card. Fine. Ship-blocking
              problems? None. But there are three things in this code that will
              bite the next person who touches it.


              **1. `AgentCommandDef.preStatus` is dead code.**


              ```ts

              export interface AgentCommandDef {
                label: string;
                verb: AgentCommandVerb;
                preStatus?: string;  // <- NEVER SET ON ANY ENTRY
              }


              export const AGENT_COMMANDS: AgentCommandDef[] = [
                { label: 'Implement', verb: 'implement' },  // no preStatus
                { label: 'Groom', verb: 'groom' },          // no preStatus
                { label: 'Finish', verb: 'finish' },        // no preStatus
                { label: 'Review', verb: 'review' },        // no preStatus
              ];

              ```


              You put a field on the interface, wired up the function to handle
              it, and then never passed it in the registry. Either use it or
              remove it. Right now it's a broken promise.


              **2. `review` is in `AgentCommandVerb` and `AGENT_COMMANDS` but
              has to be filtered out at every call site.**


              `ContextMenu.tsx` literally does `AGENT_COMMANDS.filter((item) =>
              item.verb !== 'review')`. If 'review' belongs in the registry,
              callers shouldn't have to exclude it manually. If it doesn't
              belong there (because review is persona-based, not a bare verb),
              remove it from the registry. Pick one. What you have now means the
              next person adding a call site will forget the filter and ship a
              broken "Review" menu item with no persona picker.


              **3. `statusActionMap` in `TaskCard` bypasses `kind: 'command'`
              for commands that are literally verb+id.**


              ```ts

              const statusActionMap = {
                'Grooming': { label: 'Start grooming', appendPrompt: `groom ${task.id}` },
                'Todo':     { label: 'Implement',      appendPrompt: `implement ${task.id}` },
                'In Progress': { label: 'Continue',   appendPrompt: `implement ${task.id}` },
              };

              // ...

              action: { kind: 'prompt', appendPrompt: statusAction.appendPrompt
              },

              ```


              These are `groom <id>` and `implement <id>` — identical to what `{
              kind: 'command', verb: 'groom' }` produces inside
              `runAgentAction`. But this site hand-rolls the string and uses
              `kind: 'prompt'` instead. Now the same logical operation is
              encoded two different ways depending on which button the user
              clicked. If the command format ever changes, you'll update one
              path and miss the other.


              **The circular re-export is sloppy but survivable.**
              `agentActions.ts` imports `REVIEW_PERSONAS` from
              `CodeReviewButton.tsx` and re-exports it. Half the codebase now
              imports from the proxy; `ReadyForMergePrompt` and `TaskModal`
              still import type `ReviewPersona` directly from
              `CodeReviewButton`. The plan said "moved here from
              CodeReviewButton (component re-exports for back-compat)" — it
              wasn't moved, just proxied. Fine, but be honest about it: either
              finish the move or drop the proxy and standardize on one import
              path.


              None of these are regressions from before. But this is supposed to
              be the unification ticket. Don't leave new inconsistencies behind
              when the whole point was to eliminate them.
            user: Linus Torvalds (code review)
      - timestamp: '2026-06-03T04:50:25.522Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:50:28.953Z'
        message: >-
          Review posted. Ticket stays **In Progress**.


          Four specific issues flagged:


          1. `AgentCommandDef.preStatus` field declared but never populated in
          `AGENT_COMMANDS` — dead code

          2. `review` verb is in the registry but every call site has to
          `filter` it out manually — either use it or remove it

          3. `statusActionMap` in `TaskCard` hand-rolls `groom <id>`/`implement
          <id>` strings and routes them as `kind: 'prompt'` instead of `kind:
          'command'` — same operation, two representations, guaranteed
          divergence later

          4. `REVIEW_PERSONAS` wasn't moved to `agentActions.ts`, just proxied
          from it, while some files still import directly from
          `CodeReviewButton` — pick one canonical import path


          None are regressions from before, but this was the unification ticket
          and it left new inconsistencies behind.
    user: Claude Code
    date: '2026-06-03T04:49:10.459Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:50:28.953Z'
  - type: comment
    user: Linus Torvalds (code review)
    comment: >-
      Code review — Linus mode.


      The goal was met: `grep startTaskCliSession portal/src` shows only
      `api.ts` and `agentActions.ts`. `skipPermissions` is now forwarded in
      `sendFinishCommand`. Grooming no longer pre-moves status from the card.
      Persona picker works from the card. Fine. Ship-blocking problems? None.
      But there are three things in this code that will bite the next person who
      touches it.


      **1. `AgentCommandDef.preStatus` is dead code.**


      ```ts

      export interface AgentCommandDef {
        label: string;
        verb: AgentCommandVerb;
        preStatus?: string;  // <- NEVER SET ON ANY ENTRY
      }


      export const AGENT_COMMANDS: AgentCommandDef[] = [
        { label: 'Implement', verb: 'implement' },  // no preStatus
        { label: 'Groom', verb: 'groom' },          // no preStatus
        { label: 'Finish', verb: 'finish' },        // no preStatus
        { label: 'Review', verb: 'review' },        // no preStatus
      ];

      ```


      You put a field on the interface, wired up the function to handle it, and
      then never passed it in the registry. Either use it or remove it. Right
      now it's a broken promise.


      **2. `review` is in `AgentCommandVerb` and `AGENT_COMMANDS` but has to be
      filtered out at every call site.**


      `ContextMenu.tsx` literally does `AGENT_COMMANDS.filter((item) =>
      item.verb !== 'review')`. If 'review' belongs in the registry, callers
      shouldn't have to exclude it manually. If it doesn't belong there (because
      review is persona-based, not a bare verb), remove it from the registry.
      Pick one. What you have now means the next person adding a call site will
      forget the filter and ship a broken "Review" menu item with no persona
      picker.


      **3. `statusActionMap` in `TaskCard` bypasses `kind: 'command'` for
      commands that are literally verb+id.**


      ```ts

      const statusActionMap = {
        'Grooming': { label: 'Start grooming', appendPrompt: `groom ${task.id}` },
        'Todo':     { label: 'Implement',      appendPrompt: `implement ${task.id}` },
        'In Progress': { label: 'Continue',   appendPrompt: `implement ${task.id}` },
      };

      // ...

      action: { kind: 'prompt', appendPrompt: statusAction.appendPrompt },

      ```


      These are `groom <id>` and `implement <id>` — identical to what `{ kind:
      'command', verb: 'groom' }` produces inside `runAgentAction`. But this
      site hand-rolls the string and uses `kind: 'prompt'` instead. Now the same
      logical operation is encoded two different ways depending on which button
      the user clicked. If the command format ever changes, you'll update one
      path and miss the other.


      **The circular re-export is sloppy but survivable.** `agentActions.ts`
      imports `REVIEW_PERSONAS` from `CodeReviewButton.tsx` and re-exports it.
      Half the codebase now imports from the proxy; `ReadyForMergePrompt` and
      `TaskModal` still import type `ReviewPersona` directly from
      `CodeReviewButton`. The plan said "moved here from CodeReviewButton
      (component re-exports for back-compat)" — it wasn't moved, just proxied.
      Fine, but be honest about it: either finish the move or drop the proxy and
      standardize on one import path.


      None of these are regressions from before. But this is supposed to be the
      unification ticket. Don't leave new inconsistencies behind when the whole
      point was to eliminate them.
    date: '2026-06-03T04:50:23.461Z'
    id: c-2026-06-03t04-50-23-461z
  - type: agent_session
    sessionId: 044adc73-7671-49af-a1e1-d5fc3e82bc94
    startedAt: '2026-06-03T04:51:21.285Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-06-03T04:51:21.285Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-06-03T04:51:27.106Z'
author: Agent
implementationLink: 17a6bcc3a6ec268d35ca4c11d5cf39cddc450216
order: 1
id: FLUX-361
tokenMetadata:
  inputTokens: 329865
  outputTokens: 3502
  costUSD: 0.298632
  costIsEstimated: false
  cacheReadTokens: 288952
  cacheCreationTokens: 40900
---
Audit of every launch-agent entry point found seven discrepancies caused by each call site composing `startTaskCliSession` itself instead of going through a shared helper. Same shape of problem as the original review-button gap.

## Entry points today

| Location | Component | Call |
|---|---|---|
| Card → "Launch Agent" | `ContextMenu.handleLaunchAgent` | `startTaskCliSession(id, agent, undefined, true, effort)` |
| Card → "Send for Grooming" | `ContextMenu.handleSendForGrooming` | `updateTask(status:Grooming)` → `startTaskCliSession(id, agent, 'groom <id>', true)` |
| Card → "Run agent command" (Implement/Groom/Finish/Review) | `ContextMenu.handleAgentCommand` | `startTaskCliSession(id, agent, '<cmd> <id>', true)` |
| Modal CLI panel — split button | `useCliSession.launchSession` | `startTaskCliSession(id, framework, undefined, skipPermissions, effort)` |
| Modal — Grooming button | `TaskModal.handleGrooming` | `startTaskCliSession(id, framework, 'groom <id>', skipPermissions)` |
| Modal — Finish button | `TaskModal.sendFinishCommand` | branches: active session → `sendTaskCliInput` else `startTaskCliSession(id, framework, 'finish <id>')` |
| Modal — Code Review (ReadyForMergePrompt) | `TaskModal.handleSendForCodeReview` | `updateTask(status:'In Progress')` → `startTaskCliSession(id, framework, persona.prompt, skipPermissions)` |
| Modal — Save implementationLink + launch | `TaskModal` save flow | `launchSession()` |

## Discrepancies

1. **Card "Review" ≠ Modal "Code Review"** — same word, different behavior. Card sends bare `review <id>`; modal sends a persona prompt and moves ticket to `In Progress`. `CodeReviewButton` + `REVIEW_PERSONAS` only exist in the modal; the context menu can't reach them.
2. **`sendFinishCommand` drops `skipPermissions`** — every other modal call passes the toggled value; this one always uses the API default.
3. **Grooming differs**: card moves to `Grooming` first, modal does not touch status.
4. **Card command-runner ignores effort override**. Effort picker only wired to `handleLaunchAgent`, not `handleAgentCommand` or `handleSendForGrooming`.
5. **Framework selection diverges**. Card always uses `resolveEffectiveAgent(config.defaultAgent)`; modal uses session-mutable `selectedCliFramework`. No per-ticket override consulted from the card.
6. **Hardcoded `AGENT_COMMANDS` taxonomy in `ContextMenu`** is a parallel registry — adding a new verb means editing a constant nothing else knows about.
7. **No shared helper.** `useCliSession.launchSession` only covers the bare-launch case; anything needing `appendPrompt`, a pre-status, or a persona bypasses it and calls `startTaskCliSession` directly.

Plus minor: `EFFORT_LEVELS` duplicated in `ContextMenu.tsx` and `LaunchAgentSplitButton.tsx`; `ContextMenu` always passes `skipPermissions: true` ignoring user preference.

## Implementation plan

1. **Single registry** in a new `portal/src/agentActions.ts`:
   - `AGENT_COMMANDS` (label + verb + optional preStatus).
   - `REVIEW_PERSONAS` moved here from `CodeReviewButton.tsx` (component re-exports for back-compat).
   - `EFFORT_LEVELS` (single source).
2. **One entry function** `runAgentAction({ taskId, action, framework?, effortOverride?, skipPermissions?, preStatus? })` exposed from `AppContext` so every site shares one error + refresh path. `action` is either `{ kind: 'launch' }`, `{ kind: 'command', verb }`, or `{ kind: 'prompt', appendPrompt }`.
   - Handles optional `updateTask({ status: preStatus })` first, atomically followed by `startTaskCliSession`.
   - Resolves framework via `useCliSession.selectedCliFramework` when called from modal context; falls back to `resolveEffectiveAgent(task.assignee, config.defaultAgent)` so per-ticket overrides are honored from the card.
3. **Rewire callers** to use `runAgentAction`:
   - `ContextMenu` — all three handlers + add persona submenu for "Review".
   - `TaskModal` — `handleGrooming`, `handleSendForCodeReview`, `sendFinishCommand`, save+launch path.
   - `useCliSession.launchSession` becomes a thin alias for `runAgentAction({ kind: 'launch' })`.
4. **Pass `skipPermissions`** from a single store (probably keep on `useCliSession` + a sensible default for card-initiated runs).
5. **Fix #2** (Finish dropping `skipPermissions`) and #3 (align grooming behavior — pick whichever side is correct; preference: agent moves the status itself, so neither side should pre-move for grooming).

## Validation

- From the card, all four agent commands work and respect effort + framework.
- From the card, "Review" opens persona picker matching the modal's options.
- From the modal, every existing button still behaves the same.
- Grep `startTaskCliSession` — only call site is inside `runAgentAction`.
