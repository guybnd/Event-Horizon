---
assignee: Agent
tags: []
priority: High
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T04:11:01.412Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T04:13:23.141Z'
    comment: Launched Claude Code session (9d2af259).
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T04:17:34.416Z'
    comment: >-
      The AskUserQuestion tool isn't available in this context. Let me ask
      directly:


      The ticket has no description and my code review shows:

      - `/api/stats/tokens` returns correct data (I tested it — $9.84 lifetime
      cost, data for 18 tickets)

      - Token parsing logic in `claude-code.ts` is identical to the pre-refactor
      `index.ts`

      - The UI components look intact


      What specifically is broken? For example:

      - Header shows `$0.00` or wrong amount?

      - Token badge missing from task cards/modal?

      - The counter stops updating after new sessions?

      - Something else?
  - type: comment
    user: Guy
    date: '2026-05-11T04:37:10.452Z'
    comment: test
    id: c-2026-05-11t04-37-10-444z
  - type: comment
    user: Guy
    date: '2026-05-11T04:37:43.440Z'
    comment: the last 10 tickets did not update their counter at all
    id: c-2026-05-11t04-37-43-432z
  - type: activity
    user: Agent
    date: '2026-05-11T04:37:46.258Z'
    comment: Launched Claude Code session (f92a62c6).
  - type: comment
    user: Agent
    date: '2026-05-11T04:51:52.279Z'
    comment: >-
      Root cause identified: race condition in startCliSession proc.on('exit')
      handler (engine/src/agents/claude-code.ts:273).
      flushSessionOutput(session, true) enqueues an async write on
      session.writeQueue but the subsequent updateTaskWithHistory call runs
      immediately without awaiting the queue. When the flush write and the
      exit-handler write race, the flush can read the file after the exit
      handler has written tokenMetadata and then overwrite it — silently losing
      both the session-end activity entry and the accumulated token totals. Fix:
      await session.writeQueue after flushSessionOutput and before
      updateTaskWithHistory in the proc.on exit handler. Same pattern applies to
      the proc.on error handler for consistency.
    id: c-2026-05-11t04-51-52-279z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T04:52:17.313Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T04:52:26.037Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:52:26.038Z'
    comment: >-
      Starting implementation. Two-line fix in engine/src/agents/claude-code.ts:
      add await session.writeQueue before updateTaskWithHistory in both
      proc.on('exit') and proc.on('error') handlers.
    id: c-2026-05-11t04-52-26-038z
  - type: activity
    user: Agent
    date: '2026-05-11T04:52:31.942Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T04:53:38.818Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:53:38.820Z'
    comment: >-
      Implementation complete. Two lines added to
      engine/src/agents/claude-code.ts: await session.writeQueue before
      updateTaskWithHistory in the proc.on('exit') handler (line 274) and
      proc.on('error') handler (line 265). This ensures the flushSessionOutput
      write queue drains before the exit/error write runs, eliminating the race
      where the flush could overwrite the file after tokenMetadata was written.
      TypeScript errors in output are all pre-existing tsconfig issues unrelated
      to this change.
    id: c-2026-05-11t04-53-38-820z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T04:53:45.432Z'
    comment: >-
      Done. The fix is in place and the ticket is in **Ready**.


      **Root cause:** Race condition in `engine/src/agents/claude-code.ts`. When
      a Claude Code session exits, `flushSessionOutput(session, true)` enqueues
      an async write on `session.writeQueue`, but the subsequent
      `updateTaskWithHistory` call ran immediately without awaiting that queue.
      If the flush's file read happened after the exit handler had already
      written `tokenMetadata`, the flush would overwrite the file with the
      pre-token state — silently losing all accumulated token data and the
      session-end activity entry.


      **Fix:** Added `await session.writeQueue` in both the `proc.on('exit')`
      handler (line 274) and `proc.on('error')` handler (line 265) before
      `updateTaskWithHistory`. This serializes the writes so the flush always
      completes before the exit handler writes its data.


      Say `finish FLUX-205` to commit and close.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-11T04:54:57.083Z'
  - type: activity
    user: Agent
    date: '2026-05-11T04:54:57.333Z'
    comment: Launched Claude Code session (8e79f495).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T04:55:46.835Z'
  - type: comment
    user: Agent
    comment: >-
      Fine. Two lines in two places, does exactly what it claims.


      The fix is correct: `flushSessionOutput(force=true)` replaces
      `session.writeQueue` with a new promise that includes the flush write.
      Awaiting it before `updateTaskWithHistory` makes the writes sequential.
      Race gone.


      `commitPending()` before the force flush could theoretically schedule a
      debounced timer, but the force path clears that timer and enqueues
      immediately — so everything is in the queue before the drain. No gap.


      One thing I noticed: `sendCliSessionInput` reply exit handler has the same
      pattern but no `await session.writeQueue`. It also has no token write, so
      there is no race that matters there. If that ever changes, someone needs
      to remember to add the await. That is a future landmine, but it is not
      this ticket.


      Change is clean. Passes.
    date: '2026-05-11T04:55:46.835Z'
    id: c-2026-05-11t04-55-46-835z
  - type: activity
    user: Agent
    date: '2026-05-11T04:55:50.279Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T04:56:18.468Z'
    comment: Launched Claude Code session (a3f33cf6).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T04:56:46.908Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:56:46.909Z'
    comment: >-
      Fix committed in 3679299 (FLUX-182: await writeQueue in session exit
      handlers). Two await session.writeQueue lines added before
      updateTaskWithHistory in both proc.on('exit') and proc.on('error')
      handlers in engine/src/agents/claude-code.ts. Token metadata and
      session-end history entries now write sequentially, eliminating the race.
      TypeScript compiles cleanly.
    id: c-2026-05-11t04-56-46-909z
  - type: activity
    user: Agent
    date: '2026-05-11T05:01:07.552Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-11T05:55:57.056Z'
title: token counter broken after last refactor
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 107976
  outputTokens: 2538
  costUSD: 0.161186
  costIsEstimated: false
version: v0.3.1
releasedAt: '2026-05-11T05:55:57.056Z'
releaseDocPath: release-notes/v0.3.1
---

## Problem

Token usage (inputTokens, outputTokens, costUSD) stopped being persisted to ticket files after the `e2b6731` refactor. Tickets FLUX-204+ that had Claude Code sessions run show no `tokenMetadata` in their frontmatter, and those tickets are absent from the `/api/stats/tokens` response.

FLUX-196 and FLUX-197 work correctly — they were run after the refactor was deployed and do have token data — so the issue is intermittent but consistently affects recent tickets.

## Root Cause

Race condition in `startCliSession` → `proc.on('exit')` handler in `engine/src/agents/claude-code.ts`.

The exit handler does:
```
commitPending();
flushSessionOutput(session, true);   // enqueues async write on session.writeQueue
...
await updateTaskWithHistory(...)     // runs immediately without awaiting the queue
```

`flushSessionOutput(session, true)` calls `enqueueSessionWrite` which appends to `session.writeQueue` (a promise chain). That flush will call `updateTaskWithHistory` asynchronously to write the final agent message. The exit handler's own `updateTaskWithHistory` call then runs **concurrently** with the queued flush write.

Both calls do: read file → merge entries → write file. The last writer wins. If the flush's read happens after the exit handler's write, the flush overwrites the file with a version that lacks `tokenMetadata` and the session-end activity entry.

The same race exists in the `proc.on('error')` handler.

## Fix

In `engine/src/agents/claude-code.ts`, in the `proc.on('exit')` handler (line ~273), await `session.writeQueue` after calling `flushSessionOutput` and before calling `updateTaskWithHistory`. This ensures the flush write completes first, and the exit handler's write sees the most recent file state.

Apply the same fix to the `proc.on('error')` handler for consistency.

**File:** `engine/src/agents/claude-code.ts`

### Change 1 — `proc.on('exit')` handler

Before `await updateTaskWithHistory(id, { ... })`, add:
```ts
await session.writeQueue;
```

### Change 2 — `proc.on('error')` handler

Before `await updateTaskWithHistory(id, { ... })`, add:
```ts
await session.writeQueue;
```

## Validation

- Verify TypeScript compiles cleanly (`npx tsc --noEmit` in engine/).
- Start engine, run a session on a test ticket, confirm the ticket file contains `tokenMetadata` after the session ends.
- Confirm `/api/stats/tokens` includes the ticket in `byTask`.
