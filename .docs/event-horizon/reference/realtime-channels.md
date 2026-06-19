---
title: Realtime Channels Reference
order: 4
---
# Realtime Channels Reference

How updates flow from disk to the portal. Source of truth: [`task-store.ts`](../../../engine/src/task-store.ts), [`events.ts`](../../../engine/src/events.ts), [`portal/src/AppContext.tsx`](../../../portal/src/AppContext.tsx).

> There are **three** moving parts that look overlapping but each owns a different concern. The split is intentional. Tinker with this section first if you're debugging "the board didn't refresh."

## Picture

```
┌─────────────────────┐   chokidar    ┌──────────────────────┐
│  .flux/*.md         │ ────────────▶ │  tasksCache (engine) │
│  .docs/**.md        │   add/change/ │  docsCache           │
│  .flux/config.json  │     unlink    │  configCache         │
└─────────────────────┘               └──────────┬───────────┘
                                                 │
                  ┌──────────────────────────────┼─────────────────────────────┐
                  │                              │                             │
            ┌─────▼─────┐                  ┌─────▼──────┐               ┌──────▼──────┐
            │  GET      │                  │  SSE on    │               │  MCP tools  │
            │  /api/    │                  │  /api/     │               │  (stdio)    │
            │  tasks    │                  │  events    │               │             │
            └─────┬─────┘                  └─────┬──────┘               └──────┬──────┘
                  │                              │                             │
                  │  poll every 3s while         │  push                       │  same cache,
                  │  window visible              │  activity/progress/         │  same atomic
                  │                              │  notification               │  writes
                  │                              │                             │
                  └────────────────┬─────────────┘                             │
                                   │                                           │
                            ┌──────▼──────┐                                    │
                            │  portal     │                                    │
                            │  AppContext │◀───────────────────────────────────┘
                            └─────────────┘
```

## Channel 1 — File watchers (engine ⇆ disk)

`startWatchers()` in [`task-store.ts`](../../../engine/src/task-store.ts) (line ~707) runs two chokidar watchers:

| Watcher | Path | Triggers |
|---------|------|----------|
| `activeFluxWatcher` | active flux dir (`.flux/` or `.flux-store/`) | `add` / `change` → `loadTask`; `unlink` → drop from cache; also reloads `config.json` when it changes; `ready` → reconcile orphaned CLI sessions |
| `activeDocsWatcher` | `.docs/` | `add` / `change` → `loadDoc` + reload pricing doc; `unlink` → drop from `docsCache` |

Notes:

- `.tmp` files (produced by `atomicWriteFile`) are ignored to avoid re-reading our own in-flight writes.
- Hidden files (anything starting with `.`) are ignored except the flux root itself.
- The watcher does **not** distinguish self-writes from external edits. The system tolerates a redundant reload after each save. (FLUX-290 tracks reducing this.)
- Both watchers are torn down and rebuilt on workspace switch via `activateWorkspace`.

The watcher is the source of truth for "is the cache fresh?" Every other channel reads from `tasksCache` / `docsCache` — they don't re-read the disk.

## Channel 2 — SSE push (engine → portal)

[`events.ts`](../../../engine/src/events.ts) maintains a set of connected SSE responses. `broadcastEvent(name, data)` writes `event: <name>\ndata: <json>\n\n` to every client. The portal subscribes via `new EventSource('/api/events')` in `AppContext.tsx` (~line 762).

Currently broadcast events:

| Event | Emitted by | Consumed by portal? |
|-------|-----------|---------------------|
| `activity` | agent adapters (`agents/*.ts`) | yes — patches `cliSession.currentActivity` on the matching ticket |
| `progress` | agent adapters | yes — appends to the active `agent_session` history entry |
| `notification` | `notifications.ts`, notification routes | yes — updates notification panel + unread count |
| `taskCreated` | MCP `create_ticket` / `create_subtask` | **no** — emitted but the portal does not subscribe |
| `taskUpdated` | every MCP mutation tool | **no** — emitted but the portal does not subscribe |
| `permission-request` | `permission-prompts.ts` (gated confirm tier, FLUX-605) | yes — adds a pending approval to the chat's Allow/Deny prompt (`ApprovalPrompts`). Payload: `{ id, toolName, input, conversationId, createdAt }`. |
| `permission-resolved` | `permission-prompts.ts` (on resolve **or** 120s timeout) | yes — clears the resolved/expired approval from the prompt. Payload: `{ id }`. |
| `ask-question` | `ask-questions.ts` (agent calls `ask_user_question`, FLUX-662) | yes — renders an interactive picker inline in the originating chat (`ChatQuestionPicker`, routed by `conversationId`) or a global overlay (`QuestionPrompts`) when unrouted. Payload: `{ id, questions, conversationId, createdAt }`. |
| `ask-question-resolved` | `ask-questions.ts` (on answer **or** 4min timeout) | yes — clears the answered/expired question from the picker. Payload: `{ id }`. |
| `board-rebase-proposed` | `board-rebase.ts` (orchestrator calls `propose_board_rebase`, FLUX-659) | yes — renders the batch-approval panel inline in the orchestrator dock (`ChatBoardRebasePanel`, routed by `conversationId`). Payload: `{ id, items, conversationId, createdAt }`. |
| `board-rebase-resolved` | `board-rebase.ts` (on Apply approved / Dismiss) | yes — clears the resolved batch from the panel. Payload: `{ id, results: [{ id, kind, ok, message }] }`. |

**Key consequence:** ticket-state freshness on the portal does *not* come from SSE today. It comes from polling (Channel 3). SSE is only used for high-frequency agent activity that would be wasteful to poll for.

This is the intentional current split. If you want SSE to drive ticket refresh too, you would add `taskCreated` / `taskUpdated` listeners in `AppContext.tsx` and probably drop or lengthen the poll interval. See FLUX-347.

## Channel 3 — Portal polling (portal → engine)

`AppContext.tsx` runs a visibility-aware poll:

| Constant | Value | Meaning |
|----------|-------|---------|
| `LIVE_TASK_POLL_INTERVAL_MS` | `3000` | Fetch `/api/tasks` every 3 seconds *while the window is visible*. |
| `LIVE_EVENT_DURATION_MS` | `2200` | How long a "newly arrived / moved" card stays in its animation state. |

Polling triggers also fire on:

- Tab focus (`window.focus`).
- Visibility change to visible (`document.visibilitychange`).

Hidden tabs do not poll. This keeps idle laptops quiet.

The fetched task list is normalized (`normalizeTaskList`) and diffed against the previous state via `buildTaskSignature`. The diff is what powers the create / move "live event" animations on board cards — entries flagged as new or relocated stay in their highlighted state for `LIVE_EVENT_DURATION_MS`.

## Ordering and guarantees

- **Within a single mutation** (MCP or REST): write file → broadcast SSE → return response. The portal poll may see the change before the SSE fires (rare) or after.
- **Watcher reload after self-write**: chokidar will still emit `change` for our own atomic write. `loadTask` is idempotent on the cache, so this is wasteful but safe.
- **External edits** (someone edits `.flux/FLUX-42.md` in a text editor): picked up by the watcher within chokidar's default debounce. The portal sees the change on its next poll. No SSE push for state today.
- **Sync watcher** ([`sync-watcher.ts`](../../../engine/src/sync-watcher.ts)) is a separate fourth channel for orphan-branch mode — it batches local writes into git commits and pulls remote changes. Its status stream is exposed at `GET /api/sync-status/stream` (a dedicated SSE stream, not the main `/api/events`).

## Common failure modes

| Symptom | Likely cause |
|---------|--------------|
| Board doesn't update after MCP write | Window was hidden; polling is paused. Refocus the tab. |
| Cache shows stale data after a hand-edit | Watcher missed the event (rare; check chokidar errors in stderr) — restart the engine. |
| Agent activity doesn't stream | SSE connection dropped; the `EventSource` does not auto-reconnect aggressively. Reload the portal. |
| Duplicate "newly arrived" animation | Two polls captured the new ticket; diff signature is stable, so this should not happen — file a bug if it does. |

## When changing this

Touch points for any change to realtime behavior:

- Engine: `task-store.ts` (watchers), `events.ts` (broadcast), any caller of `broadcastEvent`.
- Portal: `AppContext.tsx` (polling + EventSource setup, `buildTaskSignature` diffing).
- Docs: update this page and link from [Architecture Overview](../architecture/overview.md).

## Cross-references

- [Reference: REST API](rest-api.md) — `/api/events` and `/api/sync-status/stream` endpoints.
- [Reference: MCP Tools](mcp-tools.md) — every mutation tool also broadcasts SSE.
- [Code Map](../architecture/code-map.md) — file ownership.
