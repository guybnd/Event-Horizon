---
priority: High
effort: M
tags:
  - portal
  - refactor
  - agent
title: Unify agent-launch entry points across card and modal
status: Ready
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
    status: completed
    progress:
      - timestamp: '2026-06-03T04:51:31.623Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__change_status,mcp__event-horizon__add_comment,mcp__event-horizon__log_progress
            max_results: 5
      - timestamp: '2026-06-03T04:51:35.476Z'
        message: Reading agentActions.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/agentActions.ts
      - timestamp: '2026-06-03T04:51:36.061Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: 'portal/src/**/*.{ts,tsx}'
            path: /Users/guy/Event-Horizon
      - timestamp: '2026-06-03T04:51:36.330Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:51:40.193Z'
        message: Reading ContextMenu.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/components/ContextMenu.tsx
      - timestamp: '2026-06-03T04:51:51.330Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T04:52:05.229Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: >-
              import.*ReviewPersona|import.*REVIEW_PERSONAS|import.*CodeReviewButton
            path: /Users/guy/Event-Horizon/portal/src
            output_mode: content
      - timestamp: '2026-06-03T04:52:06.331Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:52:41.057Z'
        message: Reading ReadyForMergePrompt.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              /Users/guy/Event-Horizon/portal/src/components/task-modal/ReadyForMergePrompt.tsx
      - timestamp: '2026-06-03T04:52:51.333Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T04:53:14.040Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__log_progress
          parameters:
            ticketId: FLUX-361
            message: >-
              Addressing three issues from Linus code review: (1) remove dead
              preStatus from AgentCommandDef, (2) remove review from
              AGENT_COMMANDS and its manual filter, (3) fix statusActionMap to
              use kind:'command', (4) finish REVIEW_PERSONAS move from
              CodeReviewButton to agentActions
      - timestamp: '2026-06-03T04:53:21.336Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T04:53:51.655Z'
        message: Editing agentActions.ts
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: /Users/guy/Event-Horizon/portal/src/agentActions.ts
            old_string: >-
              import { startTaskCliSession, updateTask } from './api';

              import type { CliFramework, CliSessionSummary } from './types';

              import { REVIEW_PERSONAS, type ReviewPersona } from
              './components/CodeReviewButton';


              export { REVIEW_PERSONAS };

              export type { ReviewPersona };


              export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh',
              'max'] as const;

              export type EffortLevel = typeof EFFORT_LEVELS[number];


              export type AgentCommandVerb = 'implement' | 'groom' | 'finish' |
              'review';


              export interface AgentCommandDef {
                label: string;
                verb: AgentCommandVerb;
                /** If set, ticket is moved to this status before launching. */
                preStatus?: string;
              }


              export const AGENT_COMMANDS: AgentCommandDef[] = [
                { label: 'Implement', verb: 'implement' },
                { label: 'Groom', verb: 'groom' },
                { label: 'Finish', verb: 'finish' },
                { label: 'Review', verb: 'review' },
              ];
            new_string: >-
              import { startTaskCliSession, updateTask } from './api';

              import type { CliFramework, CliSessionSummary } from './types';


              export interface ReviewPersona {
                id: string;
                label: string;
                description: string;
                prompt: string;
              }


              export const REVIEW_PERSONAS: ReviewPersona[] = [
                {
                  id: 'senior-dev',
                  label: 'Senior Friendly Dev',
                  description: 'Collegial, constructive — quality, readability & maintainability',
                  prompt: `You are acting as a senior friendly developer performing a thorough code review of this ticket's implementation.

              Your approach: collegial, constructive, and encouraging. You care
              about code quality, readability, and maintainability. You
              highlight strengths as well as weaknesses, and always explain the
              "why" behind your suggestions.


              Steps to follow:

              1. Read the full ticket description and all history comments to
              understand what was intended.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present) to see the actual changes.

              3. Evaluate the implementation against the ticket intent.
              Consider: correctness, edge cases, naming, readability, test
              coverage, and anything that could confuse a future maintainer.

              4. Make a decision:
                 - **If changes needed**: Use the \`add_comment\` MCP tool to post a detailed review comment listing specific, actionable improvements. Leave the ticket at In Progress so the implementer sees it.
                 - **If approved**: Use the \`add_comment\` MCP tool to post a short approval comment explaining what looks good. Then use \`change_status\` to move the ticket back to "Ready".

              Keep your tone warm but precise. Lead with the most important
              feedback.`,
                },
                {
                  id: 'angry-linus',
                  label: 'Angry Linus',
                  description: 'Brutally honest — no softening, no hand-holding',
                  prompt: `You are acting as an angry Linus Torvalds performing a code review of this ticket's implementation.

              Your approach: terse, blunt, brutally honest. No softening. No
              hand-holding. If the code is bad, say so and say exactly why. You
              have zero patience for over-engineering, unnecessary abstraction,
              unclear naming, or code that looks like it was written without
              thinking. You do acknowledge good work when you see it — briefly.


              Steps to follow:

              1. Read the full ticket description and all history comments.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present).

              3. Evaluate ruthlessly. Look for: bad naming, unnecessary
              complexity, missing error handling, confusing logic, wrong
              abstractions, obvious bugs, or anything that would make you
              question whether the author thought about what they were doing.

              4. Make a decision:
                 - **If changes needed**: Use the \`add_comment\` MCP tool to post a blunt, specific review comment listing every problem clearly. Leave the ticket at In Progress.
                 - **If it's actually fine**: Use the \`add_comment\` MCP tool to post a short comment saying it passes. Then use \`change_status\` to move the ticket back to "Ready".

              Do not pad your response. Be direct.`,
                },
                {
                  id: 'architect',
                  label: 'Architect Genius',
                  description: 'System design, patterns, separation of concerns, scalability',
                  prompt: `You are acting as an elite software architect performing a code review of this ticket's implementation.

              Your approach: you think in systems. You care about design
              patterns, separation of concerns, coupling vs cohesion,
              abstractions that will age well, and choices that will either
              constrain or enable the system as it grows. You are not pedantic
              about style — you care about structure and long-term
              maintainability at scale.


              Steps to follow:

              1. Read the full ticket description and history to understand
              scope and constraints.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present).

              3. Evaluate architectural quality: Are responsibilities
              well-separated? Is the abstraction at the right level? Does this
              introduce hidden coupling? Will this scale? Are there simpler
              designs that achieve the same goal?

              4. Make a decision:
                 - **If structural issues found**: Use the \`add_comment\` MCP tool to post a detailed architectural review comment. Be specific about what to restructure and why, including proposed alternatives where helpful. Leave the ticket at In Progress.
                 - **If the architecture is sound**: Use the \`add_comment\` MCP tool to post a brief approval noting what holds up well from a design perspective. Then use \`change_status\` to move the ticket back to "Ready".`,
                },
                {
                  id: 'perf-expert',
                  label: 'Performance Expert',
                  description: 'Complexity, hot paths, bundle size, memory, re-renders',
                  prompt: `You are acting as a performance engineering expert performing a code review of this ticket's implementation.

              Your approach: you think in cycles, bytes, and render trees. You
              look for algorithmic complexity issues, unnecessary re-renders,
              wasteful allocations, blocking operations, bundle size
              contributions, and anything that hits a hot path more times than
              necessary.


              Steps to follow:

              1. Read the full ticket description and history to understand what
              was built.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present).

              3. Evaluate performance characteristics: O(n) where O(1) is
              possible? Unnecessary useEffect dependencies causing cascading
              re-renders? Large imports where tree-shaking won't help?
              Synchronous work on the main thread? Missing memoization on
              expensive computations?

              4. Make a decision:
                 - **If performance issues found**: Use the \`add_comment\` MCP tool to post a specific, actionable review comment. Quantify impact where possible and suggest concrete fixes. Leave the ticket at In Progress.
                 - **If performance is acceptable**: Use the \`add_comment\` MCP tool to post a brief approval noting it passes performance scrutiny. Then use \`change_status\` to move the ticket back to "Ready".`,
                },
                {
                  id: 'ux-expert',
                  label: 'UX/UI Expert',
                  description: 'Usability, accessibility, interaction design, visual consistency',
                  prompt: `You are acting as a senior UX/UI expert performing a code review of this ticket's implementation.

              Your approach: you think from the user's perspective first. You
              evaluate interaction design, visual hierarchy, accessibility,
              feedback loops, edge case handling in the UI, and consistency with
              established patterns in the codebase. You care about how things
              feel to use, not just how they look.


              Steps to follow:

              1. Read the full ticket description and history to understand the
              intended user experience and what was built.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present). Pay close attention to JSX,
              CSS classes, and event handlers.

              3. Evaluate UX/UI quality: Is the interaction model intuitive? Are
              loading, error, and empty states handled gracefully? Is the
              component accessible (keyboard nav, ARIA labels, focus management,
              color contrast)? Does it match the visual language of the rest of
              the portal? Are there confusing affordances or missing feedback?

              4. Make a decision:
                 - **If UX/UI issues found**: Use the \`add_comment\` MCP tool to post a detailed review comment. Be specific — name the interaction, describe the problem, and suggest a concrete fix. Leave the ticket at In Progress.
                 - **If the UX is solid**: Use the \`add_comment\` MCP tool to post a brief approval noting what works well from a user experience perspective. Then use \`change_status\` to move the ticket back to "Ready".`,
                },
              ];


              export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh',
              'max'] as const;

              export type EffortLevel = typeof EFFORT_LEVELS[number];


              export type AgentCommandVerb = 'implement' | 'groom' | 'finish';


              export interface AgentCommandDef {
                label: string;
                verb: AgentCommandVerb;
              }


              export const AGENT_COMMANDS: AgentCommandDef[] = [
                { label: 'Implement', verb: 'implement' },
                { label: 'Groom', verb: 'groom' },
                { label: 'Finish', verb: 'finish' },
              ];
      - timestamp: '2026-06-03T04:54:06.338Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T04:54:08.278Z'
        message: Editing CodeReviewButton.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: >-
              /Users/guy/Event-Horizon/portal/src/components/CodeReviewButton.tsx
            old_string: >-
              import { useEffect, useRef, useState } from 'react';

              import { ChevronDown, Search } from 'lucide-react';


              export interface ReviewPersona {
                id: string;
                label: string;
                description: string;
                prompt: string;
              }


              export const REVIEW_PERSONAS: ReviewPersona[] = [
                {
                  id: 'senior-dev',
                  label: 'Senior Friendly Dev',
                  description: 'Collegial, constructive — quality, readability & maintainability',
                  prompt: `You are acting as a senior friendly developer performing a thorough code review of this ticket's implementation.

              Your approach: collegial, constructive, and encouraging. You care
              about code quality, readability, and maintainability. You
              highlight strengths as well as weaknesses, and always explain the
              "why" behind your suggestions.


              Steps to follow:

              1. Read the full ticket description and all history comments to
              understand what was intended.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present) to see the actual changes.

              3. Evaluate the implementation against the ticket intent.
              Consider: correctness, edge cases, naming, readability, test
              coverage, and anything that could confuse a future maintainer.

              4. Make a decision:
                 - **If changes needed**: Use the \`add_comment\` MCP tool to post a detailed review comment listing specific, actionable improvements. Leave the ticket at In Progress so the implementer sees it.
                 - **If approved**: Use the \`add_comment\` MCP tool to post a short approval comment explaining what looks good. Then use \`change_status\` to move the ticket back to "Ready".

              Keep your tone warm but precise. Lead with the most important
              feedback.`,
                },
                {
                  id: 'angry-linus',
                  label: 'Angry Linus',
                  description: 'Brutally honest — no softening, no hand-holding',
                  prompt: `You are acting as an angry Linus Torvalds performing a code review of this ticket's implementation.

              Your approach: terse, blunt, brutally honest. No softening. No
              hand-holding. If the code is bad, say so and say exactly why. You
              have zero patience for over-engineering, unnecessary abstraction,
              unclear naming, or code that looks like it was written without
              thinking. You do acknowledge good work when you see it — briefly.


              Steps to follow:

              1. Read the full ticket description and all history comments.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present).

              3. Evaluate ruthlessly. Look for: bad naming, unnecessary
              complexity, missing error handling, confusing logic, wrong
              abstractions, obvious bugs, or anything that would make you
              question whether the author thought about what they were doing.

              4. Make a decision:
                 - **If changes needed**: Use the \`add_comment\` MCP tool to post a blunt, specific review comment listing every problem clearly. Leave the ticket at In Progress.
                 - **If it's actually fine**: Use the \`add_comment\` MCP tool to post a short comment saying it passes. Then use \`change_status\` to move the ticket back to "Ready".

              Do not pad your response. Be direct.`,
                },
                {
                  id: 'architect',
                  label: 'Architect Genius',
                  description: 'System design, patterns, separation of concerns, scalability',
                  prompt: `You are acting as an elite software architect performing a code review of this ticket's implementation.

              Your approach: you think in systems. You care about design
              patterns, separation of concerns, coupling vs cohesion,
              abstractions that will age well, and choices that will either
              constrain or enable the system as it grows. You are not pedantic
              about style — you care about structure and long-term
              maintainability at scale.


              Steps to follow:

              1. Read the full ticket description and history to understand
              scope and constraints.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present).

              3. Evaluate architectural quality: Are responsibilities
              well-separated? Is the abstraction at the right level? Does this
              introduce hidden coupling? Will this scale? Are there simpler
              designs that achieve the same goal?

              4. Make a decision:
                 - **If structural issues found**: Use the \`add_comment\` MCP tool to post a detailed architectural review comment. Be specific about what to restructure and why, including proposed alternatives where helpful. Leave the ticket at In Progress.
                 - **If the architecture is sound**: Use the \`add_comment\` MCP tool to post a brief approval noting what holds up well from a design perspective. Then use \`change_status\` to move the ticket back to "Ready".`,
                },
                {
                  id: 'perf-expert',
                  label: 'Performance Expert',
                  description: 'Complexity, hot paths, bundle size, memory, re-renders',
                  prompt: `You are acting as a performance engineering expert performing a code review of this ticket's implementation.

              Your approach: you think in cycles, bytes, and render trees. You
              look for algorithmic complexity issues, unnecessary re-renders,
              wasteful allocations, blocking operations, bundle size
              contributions, and anything that hits a hot path more times than
              necessary.


              Steps to follow:

              1. Read the full ticket description and history to understand what
              was built.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present).

              3. Evaluate performance characteristics: O(n) where O(1) is
              possible? Unnecessary useEffect dependencies causing cascading
              re-renders? Large imports where tree-shaking won't help?
              Synchronous work on the main thread? Missing memoization on
              expensive computations?

              4. Make a decision:
                 - **If performance issues found**: Use the \`add_comment\` MCP tool to post a specific, actionable review comment. Quantify impact where possible and suggest concrete fixes. Leave the ticket at In Progress.
                 - **If performance is acceptable**: Use the \`add_comment\` MCP tool to post a brief approval noting it passes performance scrutiny. Then use \`change_status\` to move the ticket back to "Ready".`,
                },
                {
                  id: 'ux-expert',
                  label: 'UX/UI Expert',
                  description: 'Usability, accessibility, interaction design, visual consistency',
                  prompt: `You are acting as a senior UX/UI expert performing a code review of this ticket's implementation.

              Your approach: you think from the user's perspective first. You
              evaluate interaction design, visual hierarchy, accessibility,
              feedback loops, edge case handling in the UI, and consistency with
              established patterns in the codebase. You care about how things
              feel to use, not just how they look.


              Steps to follow:

              1. Read the full ticket description and history to understand the
              intended user experience and what was built.

              2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the
              implementationLink commit if present). Pay close attention to JSX,
              CSS classes, and event handlers.

              3. Evaluate UX/UI quality: Is the interaction model intuitive? Are
              loading, error, and empty states handled gracefully? Is the
              component accessible (keyboard nav, ARIA labels, focus management,
              color contrast)? Does it match the visual language of the rest of
              the portal? Are there confusing affordances or missing feedback?

              4. Make a decision:
                 - **If UX/UI issues found**: Use the \`add_comment\` MCP tool to post a detailed review comment. Be specific — name the interaction, describe the problem, and suggest a concrete fix. Leave the ticket at In Progress.
                 - **If the UX is solid**: Use the \`add_comment\` MCP tool to post a brief approval noting what works well from a user experience perspective. Then use \`change_status\` to move the ticket back to "Ready".`,
                },
              ];
            new_string: >-
              import { useEffect, useRef, useState } from 'react';

              import { ChevronDown, Search } from 'lucide-react';

              import { REVIEW_PERSONAS, type ReviewPersona } from
              '../agentActions';


              export type { ReviewPersona };

              export { REVIEW_PERSONAS };
      - timestamp: '2026-06-03T04:54:14.736Z'
        message: Editing ContextMenu.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: /Users/guy/Event-Horizon/portal/src/components/ContextMenu.tsx
            old_string: |2-
                      {AGENT_COMMANDS.filter((item) => item.verb !== 'review').map((item) => {
                        const cmd = `${item.verb} ${task.id}`;
                        return (
                          <MenuItem
                            key={item.verb}
                            onClick={() => void handleAgentCommand(item.verb)}
                          >
                            <span className="flex-1">{item.label}</span>
                            <span className="ml-2 truncate text-[10px] text-gray-400 dark:text-gray-500">{cmd}</span>
                          </MenuItem>
                        );
                      })}
            new_string: |2-
                      {AGENT_COMMANDS.map((item) => {
                        const cmd = `${item.verb} ${task.id}`;
                        return (
                          <MenuItem
                            key={item.verb}
                            onClick={() => void handleAgentCommand(item.verb)}
                          >
                            <span className="flex-1">{item.label}</span>
                            <span className="ml-2 truncate text-[10px] text-gray-400 dark:text-gray-500">{cmd}</span>
                          </MenuItem>
                        );
                      })}
      - timestamp: '2026-06-03T04:54:18.127Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: AgentCommandVerb
            path: /Users/guy/Event-Horizon/portal/src/components/ContextMenu.tsx
            output_mode: content
      - timestamp: '2026-06-03T04:54:21.339Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T04:54:27.744Z'
        message: Editing TaskCard.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: /Users/guy/Event-Horizon/portal/src/components/TaskCard.tsx
            old_string: |2-
                const statusActionMap: Record<string, { label: string; appendPrompt: string }> = {
                  'Grooming': { label: 'Start grooming', appendPrompt: `groom ${task.id}` },
                  'Todo': { label: 'Implement', appendPrompt: `implement ${task.id}` },
                  'In Progress': { label: 'Continue', appendPrompt: `implement ${task.id}` },
                };
                const statusAction = !hasActiveCliSession && !isReadyForMerge ? statusActionMap[task.status] : null;

                const sendStatusAction = async (e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (!statusAction) return;
                  setActionBusy(true);
                  try {
                    const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
                    await runAgentAction({
                      taskId: task.id,
                      framework,
                      action: { kind: 'prompt', appendPrompt: statusAction.appendPrompt },
                      currentUser,
                    });
                    triggerRefresh();
                  } finally {
                    setActionBusy(false);
                  }
                };
            new_string: |2-
                const statusActionMap: Record<string, { label: string; verb: 'groom' | 'implement' | 'finish' }> = {
                  'Grooming': { label: 'Start grooming', verb: 'groom' },
                  'Todo': { label: 'Implement', verb: 'implement' },
                  'In Progress': { label: 'Continue', verb: 'implement' },
                };
                const statusAction = !hasActiveCliSession && !isReadyForMerge ? statusActionMap[task.status] : null;

                const sendStatusAction = async (e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (!statusAction) return;
                  setActionBusy(true);
                  try {
                    const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
                    await runAgentAction({
                      taskId: task.id,
                      framework,
                      action: { kind: 'command', verb: statusAction.verb },
                      currentUser,
                    });
                    triggerRefresh();
                  } finally {
                    setActionBusy(false);
                  }
                };
      - timestamp: '2026-06-03T04:54:30.879Z'
        message: 'Running: cd /Users/guy/Event-Horizon/portal && npx tsc --no...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              cd /Users/guy/Event-Horizon/portal && npx tsc --noEmit 2>&1 | head
              -50
            timeout: 30000
      - timestamp: '2026-06-03T04:54:35.071Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: startTaskCliSession
            path: /Users/guy/Event-Horizon/portal/src
            output_mode: content
      - timestamp: '2026-06-03T04:54:36.339Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:54:46.338Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-361
            newStatus: Ready
            comment: >-
              Fixed all three issues from the Linus code review:


              1. **Removed dead `preStatus` from `AgentCommandDef`** — field was
              never set on any entry; removed from interface and all registry
              entries.


              2. **Removed `review` from `AGENT_COMMANDS`/`AgentCommandVerb`** —
              review is persona-based, not a bare verb. Removed from the
              registry so no call site needs to filter it out manually.
              `ContextMenu.tsx` filter removed.


              3. **Fixed `statusActionMap` in `TaskCard`** — was using `kind:
              'prompt'` with hand-rolled `groom ${id}`/`implement ${id}`
              strings. Now uses `kind: 'command'` with a typed `verb` field,
              matching what `runAgentAction` already does for the same
              operations.


              4. **Finished `REVIEW_PERSONAS` move** — definitions now live in
              `agentActions.ts` (the canonical registry). `CodeReviewButton.tsx`
              re-exports `ReviewPersona` and `REVIEW_PERSONAS` from there for
              back-compat. `TaskModal.tsx` and `ReadyForMergePrompt.tsx` still
              import type `ReviewPersona` from `CodeReviewButton` — those
              re-export paths stay valid.


              TypeScript compiles clean. `startTaskCliSession` call sites:
              `api.ts` (definition) + `agentActions.ts` (sole caller).
      - timestamp: '2026-06-03T04:54:51.341Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T04:54:53.316Z'
        message: >-
          FLUX-361 is now `Ready`. Here's what was fixed:


          1. **Dead `preStatus` field** — removed from `AgentCommandDef`; it was
          wired up but never used on any entry.

          2. **`review` in `AGENT_COMMANDS`** — removed from the registry
          entirely. It's persona-based, not a bare verb. The manual
          `.filter((item) => item.verb !== 'review')` in `ContextMenu.tsx` is
          gone with it.

          3. **`statusActionMap` in `TaskCard`** — switched from `{ kind:
          'prompt', appendPrompt: 'groom FLUX-X' }` to `{ kind: 'command', verb:
          'groom' }`, so the card and context menu now encode the same
          operations the same way.

          4. **`REVIEW_PERSONAS` move completed** — definitions now live in
          `agentActions.ts`. `CodeReviewButton.tsx` re-exports them for
          back-compat, making it an honest proxy rather than the source of
          truth.
    user: Claude Code
    date: '2026-06-03T04:51:21.285Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:54:53.316Z'
  - type: activity
    user: Agent
    date: '2026-06-03T04:53:14.055Z'
    comment: >-
      Addressing three issues from Linus code review: (1) remove dead preStatus
      from AgentCommandDef, (2) remove review from AGENT_COMMANDS and its manual
      filter, (3) fix statusActionMap to use kind:'command', (4) finish
      REVIEW_PERSONAS move from CodeReviewButton to agentActions
  - type: comment
    user: Agent
    comment: >-
      Fixed all three issues from the Linus code review:


      1. **Removed dead `preStatus` from `AgentCommandDef`** — field was never
      set on any entry; removed from interface and all registry entries.


      2. **Removed `review` from `AGENT_COMMANDS`/`AgentCommandVerb`** — review
      is persona-based, not a bare verb. Removed from the registry so no call
      site needs to filter it out manually. `ContextMenu.tsx` filter removed.


      3. **Fixed `statusActionMap` in `TaskCard`** — was using `kind: 'prompt'`
      with hand-rolled `groom ${id}`/`implement ${id}` strings. Now uses `kind:
      'command'` with a typed `verb` field, matching what `runAgentAction`
      already does for the same operations.


      4. **Finished `REVIEW_PERSONAS` move** — definitions now live in
      `agentActions.ts` (the canonical registry). `CodeReviewButton.tsx`
      re-exports `ReviewPersona` and `REVIEW_PERSONAS` from there for
      back-compat. `TaskModal.tsx` and `ReadyForMergePrompt.tsx` still import
      type `ReviewPersona` from `CodeReviewButton` — those re-export paths stay
      valid.


      TypeScript compiles clean. `startTaskCliSession` call sites: `api.ts`
      (definition) + `agentActions.ts` (sole caller).
    date: '2026-06-03T04:54:46.354Z'
    id: c-2026-06-03t04-54-46-354z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T04:54:46.354Z'
author: Agent
implementationLink: 17a6bcc3a6ec268d35ca4c11d5cf39cddc450216
order: 1
id: FLUX-361
tokenMetadata:
  inputTokens: 1289694
  outputTokens: 17108
  costUSD: 1.014057
  costIsEstimated: false
  cacheReadTokens: 1184196
  cacheCreationTokens: 102332
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
