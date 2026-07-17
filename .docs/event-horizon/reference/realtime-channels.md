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
| `notification` | `notifications.ts`, notification routes | yes — updates notification panel + unread count. Payload `{ notification, unreadCount }`; `notification.type ∈ {error, prompt, completion, review, info}`. **FLUX-922** added `review` — emitted by `generateReviewNotification(ticketId, title, verdict)`, fired from the `change_status` MCP tool when a review concludes with a recorded `reviewState` (`approved` → emerald verdict chip, `changes-requested` → amber). Portal maps `review` to the **Updates** category (`notificationCategory.ts`); the verdict chip + branch chip are portal-derived from the linked task (`reviewState` / `branch`), so the payload shape is unchanged. **FLUX-1363** added `generatePlanAutoApprovedNotification(ticketId, title)` — an `info`-typed, title-scoped-dedup entry fired from `PLAN_GATE_SPEC.onApproved` (`gate-runner.ts`) only under the `loop-auto` (`Auto`) plan-gate mode, whose approval otherwise moves Grooming → Todo with zero user-facing signal (`one-pass`/`loop-confirm` already raise a `prompt` notification asking for confirmation, so they're excluded). |
| `taskCreated` | MCP `create_ticket` (incl. the `parentId` subtask path) | yes (FLUX-1282) — `AppContext.tsx` re-fetches the task list so a newly created top-level ticket appears immediately in other tabs/sessions instead of waiting for the poll. |
| `taskUpdated` | every MCP mutation tool, the portal PUT `/api/tasks/:id` route, and select engine-side writers (e.g. `gate-runner.ts`'s plan-gate auto-approve, FLUX-1485) | yes (FLUX-846) — `AppContext.tsx` re-fetches the task list (`loadTasks()`) on every `taskUpdated`, so any surface reading a ticket's fields (status, `planReviewState`, etc.) re-syncs without waiting for the poll. Electron also re-syncs the taskbar badge off this event, since a Require Input/Needs Action resolve doesn't get its own dedicated broadcast. **Not every write path broadcasts** — `updateTaskWithHistory` (task-store.ts) itself never does; the caller owns it, and a writer that forgets leaves affected surfaces stale until the next poll (this was the FLUX-1485 gap: the plan gate's `onApproved` auto-consume wrote the ticket but emitted nothing — fixed alongside FLUX-1363's own addition to the same `onApproved` callback). |
| `permission-request` | `permission-prompts.ts` → `hitl-prompts.ts` (gated confirm tier, FLUX-605) | yes — adds a pending approval to the unified pending-interactions store (FLUX-720), rendered as an Allow/Deny card **inline in the originating chat** (`ChatApprovalPanel`, routed by `conversationId`) or the unified attention surface (`AttentionDock`'s Needs you tab, FLUX-898) when its dock is closed/unrouted. Payload: `{ id, toolName, input, conversationId, createdAt }`. **Re-emitted on engine restart** from the durable `open-prompts.json` index (FLUX-833) under the same `id`, so a still-open approval re-surfaces rather than vanishing — and re-arms its timeout from the persisted `expiresAt` (one already past its deadline is swept as a timeout, not re-surfaced). |
| `permission-resolved` | `permission-prompts.ts` → `hitl-prompts.ts` (on resolve **or** 120s timeout) | yes — clears the resolved/expired approval from the prompt. Payload: `{ id }`. |
| `ask-question` | `ask-questions.ts` → `hitl-prompts.ts` (agent calls `ask_user_question`, FLUX-662) | yes — renders an interactive picker **inline in the originating chat** (`ChatQuestionPicker`, routed by `conversationId`) or the unified attention surface (`AttentionDock`'s Needs you tab, FLUX-898) when its dock is closed/unrouted. Payload: `{ id, questions, conversationId, createdAt }`. **Re-emitted on engine restart** from the durable `open-prompts.json` index (FLUX-833) under the same `id`. **FLUX-923:** a question that routes **unrouted** (`conversationId == null`, e.g. a binding/token miss — the engine logs `[hitl] ask-question … routed UNROUTED`) is still claimed inline by the single live chat (`singleActiveConversationId`) as a resilience net, so a routing miss never black-holes the inline picker; the user can also answer a single-question prompt straight from the **composer** (answer mode), not only the picker chips. |
| `ask-question-resolved` | `ask-questions.ts` → `hitl-prompts.ts` (on answer **or** 4min timeout) | yes — clears the answered/expired question from the picker. Payload: `{ id }`. |
| `board-rebase-proposed` | `board-rebase.ts` (orchestrator calls `propose_board_rebase`, FLUX-659) | yes — renders the batch-approval panel **inline in the originating chat** (`ChatBoardRebasePanel`, routed by `conversationId`; FLUX-720 un-gated this from orchestrator-only, so a proposal made from a ticket chat reaches that chat) or the unified attention surface (`AttentionDock`'s Needs you tab, FLUX-898) when its dock is closed/unrouted. Payload: `{ id, items, conversationId, createdAt }`. |
| `board-rebase-resolved` | `board-rebase.ts` (on Apply approved / Dismiss) | yes — clears the resolved batch from the panel. Payload: `{ id, results: [{ id, kind, ok, message }] }`. |
| `artifactReady` | MCP `publish_artifact` (FLUX-873) | yes — the **Artifact** panel (`ArtifactPanel.tsx`; labeled **Visual Recap** for a FLUX-976 recap revision) refreshes to the new revision when the payload's `ticketId` matches the open ticket. Payload: `{ ticketId, rev }`. (Also broadcasts `taskUpdated` so the ticket's `artifacts` pointer re-loads.) FLUX-874: a fresh publish (the agent's response to an annotation) jumps the viewer to the new revision. |
| `furnace-updated` | `furnace-store.ts` (any run create/mutate — build, ignite, stoke tick, update, stop) (FLUX-1008) | yes (S6) — the **Furnace** view re-renders the run from the payload. Payload: `{ id, run }` (the full run record). |
| `furnace-deleted` | `furnace-store.ts` (`deleteFurnaceRun`) | yes (S6) — the Furnace view drops the run. Payload: `{ id }`. |
| `perf` | the `engine/src/perf/*.ts` modules (`request-timing.ts`, `event-loop-monitor.ts`, `git-timing.ts`, `rescan-timing.ts`, `watch-storm.ts`, `load-task-timing.ts`), alongside each module's existing (already throttled/rate-limited) `log.warn('[perf] …')` (FLUX-1183; `load-task-timing.ts` added in FLUX-1202) | yes — lands in the Engine Events tab's `eh-event` buffer like any other broadcast, with a dedicated **Perf** filter chip (`categorizeEvent` in `TerminalPanel.tsx`). Payload: `{ kind, message, valueMs?, detail?, filePath? }`, `kind ∈ slow-request \| loop-stall \| slow-git \| watch-storm \| slow-rescan \| slow-load-task`. `message` mirrors the stdout warning text; `valueMs` is the measured duration (ms) where applicable; `detail` is a short free-form string (route, git command, event count); `filePath` (only on `slow-load-task`) names the ticket file whose single `loadTask()` call crossed the threshold. No aggregate/percentile data here — see `GET /api/perf` (`rest-api.md`) for that. |

All three pending-prompt feeds share one SSE subscription via `PendingInteractionsProvider` (`portal/src/components/pendingInteractions.tsx`, FLUX-720); its derived `pendingPromptConversationIds` hard-gates the dock taskbar tab of any chat awaiting input (force-pinned, un-closable, distinct prompt icon) until the prompt is resolved. **FLUX-923 dynamic attention handoff:** a prompt demands attention in exactly ONE place at a time, following its chat window's live open/minimized state — while that window is **open** the prompt shows inline only (the `AttentionDock` peek/button glow and the minimized-tab glow stay quiet, gated on `useDockOpenIds()`); the moment it is **minimized/closed** the dock + tab glow re-assert so it is never lost. The underlying record stays pending throughout — only the attention emphasis moves; it clears solely on answer/timeout. One deliberate exception: the screen-reader announcement (`AttentionDock`'s `aria-live` cue) fires on arrival **regardless** of whether the chat is open — the inline picker has no `aria-live`, so suppressing it while open would leave a SR user with no cue at all (and, because the key is marked seen on arrival, permanently silent even after a later minimize). The *visual* peek/glow remain suppressed while open (no double-demand); only the announcement is exempt.

## Host ↔ artifact-iframe `postMessage` contract (FLUX-874 / FLUX-875)

The grooming-artifact iframe is **cross-origin by design** — `sandbox="allow-scripts"` *without* `allow-same-origin` gives it a unique opaque origin, so it cannot reach the portal's DOM/cookies/storage. The only host↔artifact channel is `window.postMessage`. The engine injects fixed runtime scripts into the served HTML at serve time (`injectArtifactScripts`, `engine/src/artifacts.ts` — the Tier-2 annotation capture **and** the Tier-3 layout-audit gate, as two separate `<script>` tags so one runtime's syntax error can't disable the other); the host side lives in `ArtifactPanel.tsx`.

**Trust boundary.** Because the iframe is opaque-origin, its messages arrive with `event.origin === "null"` — the origin string is *not* trusted. The host instead validates that `event.source === <our iframe>.contentWindow` **and** a message-type allowlist (`data.ns === 'eh-artifact'`). The iframe posts to `'*'` (it can't know the parent origin); payloads carry nothing sensitive. The schema is intentionally tiny:

The annotation UX (composer, pins, tray) lives **entirely inside the iframe** (FLUX-875), so the only annotation message is the final batch on "Send" — there is no per-selection chatter and no host→iframe annotation traffic. The schema is therefore tiny:

| Direction | `type` | Payload | Meaning |
|---|---|---|---|
| iframe → host | `ready` | `{ hasGuidedControls? }` | The injected script is live on the current document. `hasGuidedControls` (FLUX-1440) is `true` when the artifact declares at least one **usable** guided-annotation control — any `data-eh-feel` host, or a `data-eh-decision` host with ≥1 `data-eh-opt` child (opt-less decision hosts are malformed: they're skipped by the upgrader and don't count, so the host never invites interaction with controls that don't exist); absent/`false` for plain artifacts, which keep the existing hide-when-empty tray. |
| iframe → host | `annotations` | `{ items:[{ id, kind?, selector, text, containerText?, label?, note?, value? }] }` | **The current annotation set, mirrored LIVE (FLUX-1362 — on every add/edit/remove, not just on a Send).** Each item carries its stable pin `id` (so a host edit/remove round-trips back to the pin), `selector` (a CSS path to the element), `kind` (FLUX-892: `'text'` selection — the default when absent — or `'element'` right-click pick; FLUX-1440 adds `'feel'` and `'decision'` for the guided-annotation controls below), `text` (the selected text, ≤300 chars, empty for element/feel/decision picks), `label` (a tag+snippet descriptor for element picks, or the control's declared label/question for feel/decision picks), `value` (FLUX-1440, optional — the captured control value: an `INPUT`/`SELECT`/`TEXTAREA`'s `.value`, an opt-in `data-eh-value`, a feel control's dialed value, or a decision's chosen option), and the user's optional `note`. The host owns the unified, editable list (the floating "N changes" pill) and composes the **single** `🎯 Artifact annotations` chat message on send — text items render `> excerpt`, element items render `⊙ \`label\``, feel items render their dialed `value`, decision items render the chosen option. |
| iframe → host | `layout-audit` | `{ ok, warnings:[{ kind, selector, detail }] }` | **FLUX-875 layout audit (non-blocking as of FLUX-1362).** Posted once layout settles (and on a `request-audit`). `kind` ∈ `overflow-x` \| `off-canvas` \| `clipped` \| `overlap`. The artifact **always renders**; the host surfaces warnings as a small header **warning icon** (hover to describe, click to copy the fix prompt) and can round-trip them to the ticket chat (a `🧪 Layout audit` message) for a corrected revision. |
| host → iframe | `request-audit` | — | Ask the iframe to re-run the layout audit (e.g. after a full-screen resize). |
| host → iframe | `remove-pin` | `{ id }` | **FLUX-1362 reverse-sync.** The user removed an annotation from the host-side pill — drop the matching `data-eh-pin`. |
| host → iframe | `update-pin` | `{ id, note }` | **FLUX-1362 reverse-sync.** The user edited a note in the host-side pill — update the matching pin's tooltip. |

**In-iframe annotation UI.** On a text selection the injected script opens a **floating composer at the selection** (clamped on-screen); "Add note" drops a numbered **pin** (`position:absolute`, scrolls with content). Clicking a pin re-opens the composer to view/edit that note (Remove is explicit). A **right-click on any element** (FLUX-892) opens the same composer anchored to that element — for non-text controls (toggles, SVG bars, buttons) that can't be text-selected — suppressing the native context menu (`preventDefault`) and drawing a brief `pointer-events:none` highlight over the target; right-clicks on our own UI pass through to the native menu. FLUX-1362: the iframe no longer renders a tray/Send — it mirrors the set to the host live, and the host owns the editable list (the floating pill). All injected nodes are tagged `data-eh-ui` (`position:fixed`/`absolute`, the highlight `pointer-events:none`) so they never alter the artifact's own layout, the layout audit skips them, and the composer ignores selections inside itself.

**Graceful degradation.** The layout audit is advisory: warnings never block the view (FLUX-1362 — the artifact always renders; a clipboard-write failure when copying the fix prompt degrades to the still-available Send-to-agent action), and if the audit never reports (artifact JS error / very heavy doc) the header indicator simply stays absent.

**Key consequence:** ticket-state freshness on the portal comes from **both** SSE and polling — `taskUpdated`/`taskCreated`/`taskDeleted` trigger an immediate `loadTasks()` (FLUX-846/1282/753) so a broadcasting writer is near-instant, while polling (Channel 3) is the backstop for any writer that doesn't broadcast (or a dropped/reconnecting SSE stream).

> **Electron desktop shell (FLUX-796).** Downstream of the `notification` SSE event, the optional Electron shell re-surfaces action-required notifications natively: a taskbar badge (count of unread `'prompt'` notifications) and focus-gated OS toasts. This is a separate portal↔desktop-shell IPC layer (`window.electronAPI` in `electron/preload.js` ↔ `eh:set-action-count` / `eh:notify` / `eh:notification-click` / `eh:set-unsaved-guard` in `electron/main.js`, driven from `AppContext.tsx` and, for the unsaved-doc close guard, `DocsScreen.tsx` — FLUX-1458), not part of this engine↔portal contract — all calls are guarded behind `window.electronAPI`, so the browser portal is unaffected. See [`electron/README.md`](../../../electron/README.md).

See FLUX-347 for the original polling design; `taskCreated`/`taskUpdated`/`taskDeleted` listeners were added later (FLUX-846/753/1282) on top of it rather than replacing it, so both mechanisms are live today (see the "Key consequence" note above).

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
