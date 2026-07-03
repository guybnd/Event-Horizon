---
title: Chat-Native Orchestration (subagents in the ticket chat)
order: 60
---
# Chat-Native Orchestration

> **Design spike — FLUX-797.** Answers two questions against the real code, then lays out the
> phased path to a first-class chat experience. This doc is the source of truth for the answers;
> the *build* work lives in the follow-up tickets linked at the bottom.

## The two questions

1. **Can a normal ticket chat session spawn subagents?**
2. **Can we see those subagents in the chat UI?**

**Short answers: (1) Yes, already. (2) Partially — they are visualized elsewhere, but not inside the chat transcript.**

---

## Q1 — Spawning subagents from chat → YES, already

The MCP delegation tools are **ungated by phase**. A `phase:'chat'` session (the per-ticket chat box
*or* the always-on `__board__` orchestrator) can call them today:

- `delegate` — **blocking**: spawns one child (single delegation) or N children (multiple, in parallel) and waits for them to reach a terminal state. (FLUX-882 merged the former `delegate_to_agent` + `delegate_parallel`.)
- `start_session` — **fire-and-forget**: spawns a phase session and returns immediately.
- `list_available_agents` — discovery.

These are defined in [`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts) and all route to
**`POST /:id/cli-session/delegate`** in [`engine/src/routes/cli-session.ts`](../../../engine/src/routes/cli-session.ts).
That endpoint:

- Auto-discovers a `groupId` (`cli-session.ts:694-700`): if none is passed, it looks for an **already-active
  supervisor lead** on the ticket (`patternPosition === 'lead' && pattern === 'supervisor'`) and reuses its `groupId`.
- Spawns the child via `spawnSession()` with `pattern:'supervisor'`, `patternPosition:'assistant'`,
  `groupType:'supervisor'`, `groupVariant:'combiner'` (`cli-session.ts:721-732`).
- `delegate` then blocks on `awaitDelegation(session.id)` (per delegation)
  (tracked in [`engine/src/session-store.ts`](../../../engine/src/session-store.ts) via
  `awaitDelegation`/`notifyDelegationComplete`).

**Idempotency / dedupe (FLUX-842, FLUX-844).** The endpoint dedupes by a stable hash of
`(taskId, personaId, task, effort)`. If the MCP transport drops the held-open response after a child
spawned, the orchestrator's retry attaches to the in-flight (or freshly-settled, within a 90s TTL)
delegation — returning the same result with `deduped: true` instead of launching a second child (this
is the ~3× review-fleet blow-up it prevents). The reservation is taken **before** `spawnSession()`
(`reserveDispatch`), so even a retry that lands *during* spawn attaches rather than double-launching; a
failed spawn releases the key so a genuine later retry can start fresh. **Caveat for callers:** because
the key is byte-identical inputs, two *intentionally identical* concurrent delegations (e.g. an
N-identical-skeptic adversarial-verify fan-out) collapse to one — vary the prompt/label by index when
you genuinely want N distinct runs.

Chat sessions are **durable** — `session-store.ts` only reaps *non-`chat`* parked phase sessions on a
status change, so a chat-driven run survives status moves.

### Verified nuance — the `groupId` gap for a *plain* chat session

The spike's working assumption was that the delegate endpoint "treats the chat session as the implicit
supervisor lead." **The code does not do that for a plain chat session**, and this is the load-bearing
prerequisite for Phase A:

- A normal per-ticket chat start (`phase:'chat'`) is launched as **`patternPosition:'standalone'`** with
  **no `groupId`, no `pattern`** (`cli-session.ts:436,440`, default portal start payload).
- `spawnSession()` only stamps `session.groupId` **when one is passed in** (`cli-session.ts:197`) — it does
  **not** generate one when absent.
- Therefore, when a *standalone* chat session calls `delegate`, the lead-discovery finds no supervisor lead,
  `groupId` stays `undefined`, and the **child is spawned with no `groupId`**. There is no shared run identity
  to group the chat and its delegate on.

> **Contrast:** sessions launched via `start_session` for a *phase* (grooming/implementation/review/finalize,
> e.g. the dev-lead/planner sessions) **are** stamped as `pattern:'supervisor'`, `patternPosition:'lead'`, with a
> `groupId`. So delegation grouping already works for those; it's specifically the **plain chat box** that is
> standalone and ungrouped.

**Implication:** before chat can scope a run "by group," the delegate endpoint must give a chat-as-lead a real
`groupId` — either generate-and-stamp one on first delegation, or promote the standalone chat to supervisor-lead.
This is a small, well-contained engine change (captured in FLUX-803's "shared plumbing, do first" step), and it
corrects the spike's "no engine change strictly required" note.

---

## Q2 — Seeing them in the chat UI → PARTIALLY

Subagent / group activity **is** surfaced in three places today — none of them the chat transcript:

- [`RunView.tsx`](../../../portal/src/components/task-modal/RunView.tsx) — full `OrchestrationTopology` + per-session live
  output, inside `DetailsPanel`.
- [`ActiveSessionsPopover.tsx`](../../../portal/src/components/ActiveSessionsPopover.tsx) — `GroupItem` +
  topology glyph.
- [`HistoryList.tsx`](../../../portal/src/components/task-modal/HistoryList.tsx) — `GroupedSessionHistory` groups sessions
  by `groupId` after the run.

The **chat pane itself does not show them.** [`ChatView.tsx`](../../../portal/src/components/task-modal/ChatView.tsx) is
driven by [`useChatSession(conversationId)`](../../../portal/src/hooks/useChatSession.ts), which is
**ticket/conversation-scoped**: it renders only the lead session's `messages` + streamed `liveText`
(`assistantDelta` SSE), and its event handlers refetch the transcript rather than rendering per-delegate lanes
(`useChatSession.ts:164-181`).

### What's actually on the wire (Phase A is mostly portal work)

Good news for Phase A: delegate sessions run **under the same `taskId`** as the chat, and the realtime
`activity`/`progress` SSE events are filtered in the chat hook by `taskId` — so **the delegates' events already
reach the chat subscriber**. The per-session live data also already exists in the live-session store
(`progressBySession[sessionId]` in [`AppContext.tsx`](../../../portal/src/AppContext.tsx); see
[Realtime Channels](../reference/realtime-channels.md)). The gaps are:

1. **Selection** — the chat hook doesn't *select* sibling sessions (it only follows the lead), and it has no
   clean run-scope to select by until the `groupId` gap above is fixed.
2. **Rendering** — `ChatView` has no surface that renders the group; it only renders the lead bubble stream.

So Phase A needs **no new union endpoint for same-ticket delegates** — the events arrive — but it **does** need
the `groupId` stamping fix (for run identity) plus the two new render surfaces.

**Net:** the *capability* exists; the *chat-native experience* (suggest-or-launch from a plain message + see
delegates inline) does not.

---

## Phased approach

### Phase A — Make delegates visible in chat *(the real gap, portal-led)* → **[FLUX-803](#follow-ups)**
Shift the chat from ticket-scoped to **group-scoped** live data and add two surfaces (direction chosen by user):

- **Presence rail** — slim strip pinned to the top of `ChatView`, shown only while ≥1 session in the run is
  active; agent chips (icon + role + pulsing dot + activity), click → live-output drawer; collapses when the run ends.
- **Inline orchestration block** — a **prominent, first-class "run" card** dropped into the transcript at the
  spawn point (full-width, violet orchestration accent, `OrchestrationTopology` header, per-delegate lanes) —
  explicitly **not** styled as a minimal/collapsed tool-call block. Collapses to a re-expandable summary chip on
  completion.

Both reuse `RunView` / `OrchestrationTopology` / `GroupedSessionHistory` renderers — they are new *shells* over
existing components, not a reimplementation. **Prerequisite: the `groupId` stamping fix from Q1.**

### Phase B — "Suggest a supervisor run" from a plain message *(UX, low risk)* → **[follow-up](#follow-ups)**
When the chat agent recognizes an orchestratable intent ("let's do a review/groom/implement"), it proposes a run
via the existing `actions`/`quickReplies` props on `ChatView` — e.g. a **"Run review (3 agents)"** button that
fires `delegate`/`start_session`. The launch primitives already exist; this is mostly prompt/skill
guidance + wiring one action. The confirm-button default is the **cost guard**.

### Phase C — *(optional, gated)* auto-launch from intent → **[follow-up](#follow-ups)**
Let the agent start a supervisor run directly from intent, **no confirm click**, behind a per-ticket/board
setting (tag `cost`). Higher blast-radius (cost, surprise) — keep opt-in. Reuses Phase A visibility so the user
can watch/stop it.

---

## Risks / caveats

- **`delegate_*` (blocking) vs `start_session` (fire-and-forget).** Chat visibility matters most for the
  fire-and-forget / parallel cases where the lead keeps talking while children run; the blocking delegate already
  serializes.
- **Cost / runaway delegates.** A chat that casually spawns supervisor fleets burns tokens fast. Phase B's
  confirm-button default is the guard; Phase C must stay opt-in.
- **`groupId` for chat-as-lead.** Verified gap (see Q1) — must be fixed before the portal can group a plain
  chat's delegates by run.
- **Don't duplicate `RunView`.** The rail and block are new shells over existing topology/live-output renderers.
- **No regression to single-session chats** — both surfaces must no-op when there is no group (the common case).

---

## Follow-ups

| Phase | Ticket |
|---|---|
| A — delegates visible in chat (presence rail + inline run card) | **FLUX-803** |
| B — suggest-a-run chat action | **FLUX-805** |
| C — gated auto-launch from intent | **FLUX-806** |

## Key files

- [`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts) — delegation MCP tools (ungated by phase).
- [`engine/src/routes/cli-session.ts`](../../../engine/src/routes/cli-session.ts) — `delegate` endpoint,
  `groupId` auto-discovery + stamping, `spawnSession`.
- [`engine/src/session-store.ts`](../../../engine/src/session-store.ts) — `awaitDelegation`/`notifyDelegationComplete`, chat-session reaping.
- [`portal/src/hooks/useChatSession.ts`](../../../portal/src/hooks/useChatSession.ts) — ticket-scoped chat hook (extend for group scope).
- [`portal/src/components/task-modal/ChatView.tsx`](../../../portal/src/components/task-modal/ChatView.tsx) — chat pane; host the rail + inline block.
- [`portal/src/components/task-modal/RunView.tsx`](../../../portal/src/components/task-modal/RunView.tsx), `OrchestrationTopology.tsx`, `task-modal/HistoryList.tsx` (`GroupedSessionHistory`) — reusable topology/live-output/grouping renderers.
- [`portal/src/AppContext.tsx`](../../../portal/src/AppContext.tsx) — live-session store (`progressBySession`, `subscribeToEvent`).

## See also

- [Agent Integrations](../agent-integrations.md), [Agent Adapter Contract](../reference/agent-adapter-contract.md)
- [ADR 0002 — Multi-Agent CLI](../decisions/0002-multi-agent-cli.md), [ADR 0003 — Orchestration Runtime](../decisions/0003-orchestration-runtime.md)
- [Realtime Channels](../reference/realtime-channels.md), [MCP Tools](../reference/mcp-tools.md)
