---
assignee: unassigned
tags:
  - feature
  - ai
  - portal
  - ui
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:35:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T04:35:00.000Z'
    comment: >-
      Applied remaining display fixes:


      1. **TaskCard** — cost pill now always renders for every card. Shows
      `$X.XXXX` when cost > 0, `↑Xk ↓Xk` when tokens recorded but no USD
      estimate, `$0.00` for new/empty tickets.

      2. **TaskModal session row** — session cost now shows `$0.00` at zero
      instead of `↑0.0k ↓0.0k` tokens.

      3. **TaskModal ticket total** — always renders when a cliSession is
      present or tokenMetadata exists, with same fallback logic.

      4. **Estimation engine** — already in place from prior session: uses local
      MODEL_PRICING table to estimate when `cost_usd` not in result event, marks
      as `~` estimated.


      Portal TypeScript clean. Engine pre-existing TS module errors unchanged
      (not caused by this work).
    id: c-2026-05-09t04-35-00-000z
  - type: comment
    user: Claude Code
    date: '2026-05-09T08:00:00.000Z'
    comment: >-
      ## Completed


      **Pricing doc** — `.docs/event-horizon/model-pricing.md` created with
      up-to-date rates for all current Claude models (Opus/Sonnet/Haiku 4.5,
      4.6, 4, 3.5, 3). Engine reads and parses the markdown table on startup and
      on every file save via chokidar, so rates hot-reload without a restart.
      Longest model name matches first to avoid ambiguity.


      **Token/cost display toggle** — `tokenDisplayMode: cost | tokens` added to
      Config. A new toggle in Settings ("Show Token Count Instead of Cost")
      flips all three surfaces simultaneously:

      - **Top bar** — switches between `$X.XX` lifetime cost and `↑Xk ↓Xk`
      lifetime tokens

      - **Kanban cards** — cost pill respects the setting

      - **Ticket modal** (both the session row and the ticket header badge) —
      same


      Setting persists in the workspace config file and applies instantly
      without a page reload.
    id: c-flux-149-done
  - type: status_change
    from: In Progress
    to: Done
    user: Claude Code
    date: '2026-05-09T08:00:00.000Z'
title: feature to count token spend per card to estimate costs in USD
status: Done
createdBy: Guy
updatedBy: Claude Code
description: >-
  ## Overview


  Track Claude API token spend per session and surface cost estimates (USD) in
  the portal UI. The Claude CLI already emits `cost_usd` and `usage`
  (input/output token counts) on the `result` event in its `--output-format
  stream-json` output — the engine parses these events today but discards the
  token data. This ticket wires that data through the full stack.


  ## Token Data Source


  The `result` event emitted by the Claude CLI includes:

  ```json

  {"type": "result", "cost_usd": 0.0042, "usage": {"input_tokens": 3100,
  "output_tokens": 412}}

  ```

  This is already received at `engine/src/index.ts:1149–1214` in the
  `proc.stdout.on("data")` handler. We only need to extract and accumulate the
  values.


  ## Implementation Plan


  ### 1. Engine — Add token fields to `CliSessionRecord` / `CliSessionSummary`


  **File:** `engine/src/index.ts`


  - Add to `CliSessionSummary` interface (line ~99):
    ```ts
    inputTokens?: number;
    outputTokens?: number;
    costUSD?: number;
    ```
  - Add same fields to `CliSessionRecord` (line ~117) with defaults `0`.

  - Initialize them to `0` when a new session record is created.


  ### 2. Engine — Extract token data from the `result` event


  **File:** `engine/src/index.ts` — inside `proc.stdout.on(data)` handler (~line
  1157)


  Add a branch for `evt.type === result`:

  ```ts

  if (evt.type === result && typeof evt.cost_usd === number) {
    session.costUSD = (session.costUSD ?? 0) + evt.cost_usd;
    session.inputTokens = (session.inputTokens ?? 0) + (evt.usage?.input_tokens ?? 0);
    session.outputTokens = (session.outputTokens ?? 0) + (evt.usage?.output_tokens ?? 0);
  }

  ```

  Accumulate rather than replace so multi-turn resumed sessions (send-input) sum
  correctly across turns.


  ### 3. Engine — Serialize token data in `getCliSessionSummaryForTask`


  **File:** `engine/src/index.ts` — `getCliSessionSummaryForTask` function
  (~line 178)


  Include `inputTokens`, `outputTokens`, `costUSD` in the returned summary
  object.


  ### 4. Engine — Persist token data to ticket frontmatter on session end


  **File:** `engine/src/index.ts` — `proc.on(exit)` handler (~line 1233)


  After the session ends (any terminal state: completed, cancelled, failed),
  call `updateTaskWithHistory` with an extra `tokenMetadata` merge.
  Specifically, update the task directly via `tasksCache` to accumulate:

  ```ts

  const task = tasksCache[id];

  const prev = task.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD:
  0 };

  const next = {
    inputTokens: prev.inputTokens + (session.inputTokens ?? 0),
    outputTokens: prev.outputTokens + (session.outputTokens ?? 0),
    costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
  };

  ```

  Pass `{ tokenMetadata: next }` as part of the `updateTaskWithHistory` options
  (or set it directly on the frontmatter before stringify). This survives engine
  restart.


  ### 5. Engine — Expose lifetime totals on a stats endpoint


  **File:** `engine/src/index.ts`


  Add `GET /api/stats/tokens` that returns:

  ```json

  {
    "lifetime": { "inputTokens": N, "outputTokens": N, "costUSD": N },
    "byTask": { "FLUX-12": { ... }, ... }
  }

  ```

  Computed by summing `tokenMetadata` from all tasks in `tasksCache`. This
  enables the lifetime summary display and avoids shipping all task data to the
  portal just for aggregation.


  ### 6. Portal — Extend types


  **File:** `portal/src/types.ts`


  - Add to `CliSessionSummary`:
    ```ts
    inputTokens?: number;
    outputTokens?: number;
    costUSD?: number;
    ```
  - Add to `Task`:
    ```ts
    tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number };
    ```

  ### 7. Portal — Per-task cost in TaskModal


  **File:** `portal/src/components/TaskModal.tsx`


  In the session panel footer area, add a small token summary line when
  `task.tokenMetadata` or `task.cliSession` has cost data:

  - Current session: `↑ 3.1k / ↓ 412 · $0.0042` (live, from `cliSession`)

  - Ticket total: `Ticket total: $0.02` (from `task.tokenMetadata`)


  ### 8. Portal — Per-task cost badge in TaskCard


  **File:** `portal/src/components/TaskCard.tsx`


  When `task.tokenMetadata?.costUSD > 0`, show a subtle cost pill in the card
  footer alongside the existing session status badge. Example: `$0.02`.


  ### 9. Portal — Lifetime cost in Header


  **File:** `portal/src/components/Header.tsx`


  Fetch `GET /api/stats/tokens` on mount (and after each session completes via
  SSE). Show a lifetime total cost figure near the "Agent Sessions" indicator.
  Example: `$1.24 lifetime`.


  ## Acceptance Criteria


  - `cost_usd` from `result` events is accumulated per session in memory.

  - On session end, per-task `tokenMetadata` is persisted to the ticket `.md`
  file.

  - `GET /api/stats/tokens` returns correct lifetime and per-task totals.

  - `CliSessionSummary` exposes live token counts for the active session.

  - TaskModal shows live per-session cost and ticket lifetime cost.

  - TaskCard shows a cost pill for tickets with any recorded spend.

  - Header shows a lifetime cost figure.

  - Costs survive engine restart (read from `tokenMetadata` frontmatter field).


  ## Out of Scope


  - Per-day / calendar aggregation (deferred to follow-up ticket).

  - Model-specific pricing overrides (use `cost_usd` from the CLI which already
  reflects the real price paid).

  - Copilot CLI cost tracking (only Claude sessions emit this data).
---
## Overview

Track Claude API token spend per session and surface cost estimates (USD) in the portal UI. The Claude CLI already emits `cost_usd` and `usage` (input/output token counts) on the `result` event in its `--output-format stream-json` output — the engine parses these events today but discards the token data. This ticket wires that data through the full stack.

## Token Data Source

The `result` event emitted by the Claude CLI includes:
```json
{"type": "result", "cost_usd": 0.0042, "usage": {"input_tokens": 3100, "output_tokens": 412}}
```
This is already received at `engine/src/index.ts:1149–1214` in the `proc.stdout.on("data")` handler. We only need to extract and accumulate the values.

## Implementation Plan

### 1. Engine — Add token fields to CliSessionRecord / CliSessionSummary

**File:** `engine/src/index.ts`

Add to `CliSessionSummary` interface (~line 99) and `CliSessionRecord` (~line 117):
```ts
inputTokens?: number;
outputTokens?: number;
costUSD?: number;
```
Initialize to `0` when a new session record is created.

### 2. Engine — Extract token data from the result event

**File:** `engine/src/index.ts` — inside `proc.stdout.on("data")` handler (~line 1157)

Add a branch for `evt.type === "result"`:
```ts
if (evt.type === "result" && typeof evt.cost_usd === "number") {
  session.costUSD = (session.costUSD ?? 0) + evt.cost_usd;
  session.inputTokens = (session.inputTokens ?? 0) + (evt.usage?.input_tokens ?? 0);
  session.outputTokens = (session.outputTokens ?? 0) + (evt.usage?.output_tokens ?? 0);
}
```
Accumulate rather than replace so multi-turn sessions sum correctly across send-input turns.

### 3. Engine — Serialize token data in getCliSessionSummaryForTask

**File:** `engine/src/index.ts` — `getCliSessionSummaryForTask` (~line 178)

Include `inputTokens`, `outputTokens`, `costUSD` in the returned summary object.

### 4. Engine — Persist token data to ticket frontmatter on session end

**File:** `engine/src/index.ts` — `proc.on("exit")` handler (~line 1233)

After the session ends, accumulate into `task.tokenMetadata` before the `updateTaskWithHistory` call:
```ts
const prev = task.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
tasksCache[id].tokenMetadata = {
  inputTokens: prev.inputTokens + (session.inputTokens ?? 0),
  outputTokens: prev.outputTokens + (session.outputTokens ?? 0),
  costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
};
```
`updateTaskWithHistory` uses `tasksCache[id]` for the frontmatter, so the field will be written to the `.md` file automatically.

### 5. Engine — Add GET /api/stats/tokens endpoint

**File:** `engine/src/index.ts`

Returns lifetime and per-task token totals by summing `tokenMetadata` across `tasksCache`:
```json
{
  "lifetime": { "inputTokens": N, "outputTokens": N, "costUSD": N },
  "byTask": { "FLUX-12": { ... } }
}
```

### 6. Portal — Extend types

**File:** `portal/src/types.ts`

Add to `CliSessionSummary`: `inputTokens?`, `outputTokens?`, `costUSD?`
Add to `Task`: `tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number }`

### 7. Portal — Per-task cost in TaskModal

**File:** `portal/src/components/TaskModal.tsx`

In the session panel, add a token summary line:
- Current session (live): `↑ 3.1k / ↓ 412 · $0.0042` (from `cliSession`)
- Ticket total: `Ticket total: $0.02` (from `task.tokenMetadata`)

### 8. Portal — Per-task cost badge in TaskCard

**File:** `portal/src/components/TaskCard.tsx`

When `task.tokenMetadata?.costUSD > 0`, show a subtle cost pill in the card footer: `$0.02`.

### 9. Portal — Lifetime cost in Header

**File:** `portal/src/components/Header.tsx`

Fetch `GET /api/stats/tokens` on mount and after session SSE events. Show lifetime cost near the Agent Sessions indicator: `$1.24 lifetime`.

## Acceptance Criteria

- `cost_usd` from `result` events is accumulated per session in-memory.
- On session end, per-task `tokenMetadata` is persisted to the ticket `.md` file.
- `GET /api/stats/tokens` returns correct lifetime and per-task totals.
- `CliSessionSummary` exposes live token counts for the active session.
- TaskModal shows live per-session cost and ticket lifetime cost.
- TaskCard shows a cost pill for tickets with any recorded spend.
- Header shows a lifetime cost figure.
- Costs survive engine restart (read from `tokenMetadata` frontmatter field).

## Out of Scope

- Per-day / calendar aggregation (deferred to a follow-up).
- Model-specific pricing overrides (use `cost_usd` directly from the CLI).
- Copilot CLI cost tracking (only Claude sessions emit this data).
nents/Header.tsx`

Fetch `GET /api/stats/tokens` on mount and after session SSE events. Show lifetime cost near the Agent Sessions indicator: `$1.24 lifetime`.

## Acceptance Criteria

- `cost_usd` from `result` events is accumulated per session in-memory.
- On session end, per-task `tokenMetadata` is persisted to the ticket `.md` file.
- `GET /api/stats/tokens` returns correct lifetime and per-task totals.
- `CliSessionSummary` exposes live token counts for the active session.
- TaskModal shows live per-session cost and ticket lifetime cost.
- TaskCard shows a cost pill for tickets with any recorded spend.
- Header shows a lifetime cost figure.
- Costs survive engine restart (read from `tokenMetadata` frontmatter field).

## Out of Scope

- Per-day / calendar aggregation (deferred to a follow-up).
- Model-specific pricing overrides (use `cost_usd` directly from the CLI).
- Copilot CLI cost tracking (only Claude sessions emit this data).
