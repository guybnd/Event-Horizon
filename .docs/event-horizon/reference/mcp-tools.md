---
title: MCP Tools Reference
order: 1
---
# MCP Tools Reference

Authoritative list of every tool exposed by the Event Horizon MCP server ([`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts)). Each entry lists the input schema, output shape, side effects, and enforcement rules.

> Agents should prefer MCP tools over the REST API. The portal uses REST; agents use MCP. Both share the same in-memory state and validation.

## How tools are exposed

The tool set is built once by `buildMcpServer()` ([`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts)) and served over Streamable-HTTP, via `@modelcontextprotocol/sdk`. (A stdio transport existed prior to FLUX-646 for a headless `--mcp` entry point; it was retired since every real install path already used HTTP exclusively — `--mcp` now fails fast with an informative error instead of starting a second transport.)

### Streamable-HTTP, in-process on the engine (FLUX-645)

The already-running portal engine mounts the MCP server in-process and exposes it over loopback HTTP at `POST/GET/DELETE http://127.0.0.1:<engine-port>/mcp` (`handleMcpHttpRequest`, wired in [`engine/src/index.ts`](../../../engine/src/index.ts)). Every Claude Code session — whether opened in the main checkout or in a `.eh-worktrees/*` git worktree — points at this one URL and shares the engine's **single** task-store cache and chokidar watchers. There is **no per-session stdio process** and no per-request `--workspace`; the server binds to the engine's already-active canonical workspace.

The installer renders the location-independent HTTP entry into `.mcp.json` with the configured port, re-writing it on every engine start so a port change is picked up:

```json
"event-horizon": { "type": "http", "url": "http://127.0.0.1:3067/mcp", "alwaysLoad": true }
```

Key properties:

- **Per-session isolation.** Each session gets its own `StreamableHTTPServerTransport`, keyed by the `Mcp-Session-Id` header the transport assigns on `initialize`; transports are removed on close. Concurrent sessions never cross-talk.
- **Raw stream, not pre-parsed.** The `/mcp` routes are registered **before** `express.json()` so the JSON-RPC request stream reaches the transport unparsed — `express.json()` would otherwise consume the body and the transport would hang.
- **Per-ticket write serialization.** With one shared server, concurrent sessions can issue concurrent read-modify-write on the same ticket's history. `updateTaskWithHistory` ([`engine/src/task-store.ts`](../../../engine/src/task-store.ts)) serializes writes per `ticketId` (a promise chain) so near-simultaneous `add_note`/`change_status` calls on one ticket no longer drop history entries; writes to *different* tickets stay parallel.
- **Engine-restart reconnect caveat.** The MCP connection is bound to the engine process, so restarting the engine (e.g. the tsx-watch dev loop restarting on a code edit, or a customer update/crash) drops the connection. Claude Code reconnects on its next call; mid-call work in flight at the moment of restart is lost. This is the accepted residual for the single-process design.

## Server instructions & tool annotations (FLUX-948)

Beyond the tool list, `buildMcpServer()` exposes two pieces of standard MCP metadata so the server behaves well with **any** client, not just a Claude Code harness that loads [`.claude/rules/event-horizon.md`](../../../.claude/rules/event-horizon.md):

- **Server `instructions`** — the second argument to the `McpServer` constructor (`ServerOptions.instructions`). On `initialize` the client folds this string into its system prompt (the "MCP Server Instructions" block). It is a deliberately compact projection of the orchestrator contract: manage tickets only through these tools, never edit `.flux/`/`.flux-store/` directly, `get_ticket` before acting, move columns with `change_status` (comment required for Require Input / Ready), end every working turn on a board action, and raise every decision through a structured surface (`ask_user_question` / Require Input) rather than chat prose. Keep it short — it bills every session.
- **Tool annotations** — each read-only and destructive tool is registered with the `tool(name, description, schema, annotations, cb)` overload. `ToolAnnotations` is `{ title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }`; all fields are **hints** a client may use to render a label, auto-allow reads, or gate destructive calls. They are advisory only — EH's own approval gating still lives in [`permission_prompt`](#permission_prompt) and the engine, not in these hints.

| Annotation | Tools |
|------------|-------|
| `readOnlyHint: true` (+ `openWorldHint: false`) | `get_ticket`, `get_session_log`, `list_tickets`, `get_board_config`, `get_project_group`, `list_available_agents`, `get_board_state`, `permission_prompt` |
| `destructiveHint: true` | `archive`, `merge_tickets`, `finish_ticket` (also `openWorldHint: true` — it merges/pushes via `gh`) |

Multiplexed tools whose actions span read and mutation (`branch`, `group_doc`) are left without a blanket read-only/destructive hint this pass, since no single hint is accurate for all of their actions.

> Richer protocol capabilities from the FLUX-947 epic — **structured output** (`outputSchema`/`structuredContent`, FLUX-950), **resources & resource templates** (FLUX-949), and **prompts / slash commands** (FLUX-951) — are now exposed (the sections below). **Elicitation** (FLUX-952) is **not** yet.

## Resources & resource templates (FLUX-949)

Beyond tools, `buildMcpServer()` registers a set of **read-only resources** so a client (Claude Code, Cursor, raw SDK) can `@`-mention Event Horizon content straight into context **without spending a tool call**. Resources are pull-only by protocol — there is no `resources/write` — so they need no `permission_prompt` gating (they are the resource analogue of the `readOnlyHint: true` tools). `registerResource(...)` auto-enables the server's `resources` capability, exactly the way `tool(...)` enables `tools`; the resources are served unchanged over **both** transports above (no transport change).

**Every resource reuses the matching tool's projection verbatim** — there is no second data shape to drift. A resource read returns byte-identical content to the tool it mirrors.

| URI | Kind | MIME | Source projection (reused) |
|-----|------|------|----------------------------|
| `board://config` | fixed | `application/json` | `buildBoardConfigProjection()` — identical to [`get_board_config`](#get_board_config) |
| `board://state` | fixed | `application/json` | `GET /api/board/state` — identical to [`get_board_state`](#get_board_state) |
| `ticket://{id}` | template | `application/json` | `serializeTaskForAgent(task)` with `_path` stripped — identical to [`get_ticket`](#get_ticket) (oversized bodies get the same `truncateBodyForAgent` treatment) |
| `docs://{+path}` | template | `text/markdown` | `docsCache[normalizeDocPathInput(path)].body` — the repo's own `.docs/` markdown |

### `resources/list` vs `resources/templates/list`

- **`resources/list`** returns the two fixed resources (`board://config`, `board://state`) **plus** the entries each template's `list` callback enumerates:
  - `ticket://{id}` enumerates **active (non-terminal) tickets only** (via `selectTicketsForList`, the same active screen as `list_tickets`), so a board with hundreds of Done/Released/Archived tickets never dumps them all into the resource list (which would re-bill discovery on every client refresh).
  - `docs://{+path}` enumerates the repo's `.docs/` entries (bounded, ~dozens); cross-project **group docs are excluded** — read those via the [`group_doc`](#group_doc) tool.
- **`resources/templates/list`** advertises the two templates: `ticket://{id}` and `docs://{+path}`.

### `docs://` path handling — `{+path}` and traversal safety

The docs template is registered as `docs://{+path}` (RFC 6570 **reserved expansion**), **not** `docs://{path}`. A plain `{path}` compiles to `([^/,]+)` and stops at the first `/`, so a multi-segment URI like `docs://event-horizon/reference/mcp-tools` would never bind; `{+path}` compiles to `(.+)` and captures the whole path. (`docs://INDEX` resolves `.docs/INDEX.md` because `normalizeDocPathInput('INDEX')` keys `docsCache['INDEX']`; `docs://INDEX.md` resolves the same key — the `.md` suffix is stripped.)

Every doc lookup is routed through `normalizeDocPathInput`, which rejects `..`, `.`, absolute, and empty segments (→ `null`), and **only ever indexes `docsCache`** — it never builds a filesystem path from the URI. A read outside `.docs/` is therefore impossible: `docs://../engine/src/mcp-server.ts` is refused before any file is touched.

### Read errors (not empty content)

A resource read that cannot be satisfied throws an `McpError` carrying a machine-readable discriminant in its `data.code` (mirroring the tool [error model](#error-model)) — it never returns empty content:

| Case | `data.code` |
|------|-------------|
| `ticket://{id}` unknown id, or `docs://{+path}` unknown path | `not_found` |
| `ticket://949` (bare number — ambiguous project key) | `validation_failed` |
| `docs://…/..` (traversal / malformed path) | `validation_failed` |
| `board://state` when the engine HTTP API is unreachable | `channel_unavailable` |

## Structured output (FLUX-950)

The core read tools — `get_ticket`, `list_tickets`, `get_board_config` — are registered with `registerTool(name, { description, inputSchema, outputSchema, annotations }, cb)` and return their payload as **`structuredContent`** (typed JSON the client validates against the advertised `outputSchema`) instead of a stringified text blob.

**One representation on the wire (AXI #1).** `structuredContent` *replaces* the text JSON — it is **not** emitted alongside a second full copy. The `content` block is empty (`[]`). Returning both would put two copies of the payload on the wire and double per-call tokens, the exact opposite of AXI #1 (token budget is first-class). The helper is `structuredResult(obj)` in [`mcp-server.ts`](../../../engine/src/mcp-server.ts) — the structured successor to `jsonResult` — and it keeps `content: []` explicit so the SDK still runs `structuredContent` through the tool's `outputSchema` as a guardrail. Measured on a representative `get_ticket`, the structured payload is *smaller* than the old compact-text shape (it drops the JSON-in-a-JSON-string escaping and the text wrapper), so the change never inflates the payload.

- **Schemas are loose** — `z.object({ … }).catchall(z.unknown())` with every field optional. The SDK's client-side validator enforces the generated JSON Schema strictly (`additionalProperties: false` by default), which would otherwise reject the rich, open-ended task projection (and the shared error envelope). Loose + optional documents the stable fields for typed clients while tolerating extra/absent fields.
- **`structuredContent` is always an object**, never a bare array — so `list_tickets` always returns the `{ tickets, note? }` envelope (the pre-FLUX-950 bare-array success shape is gone from the wire).
- **Error path unchanged** — `errorResult` still emits a human-readable text block *and* `structuredContent: { code, message }`, and the SDK skips `outputSchema` validation for `isError` results, so a client that ignores `structuredContent` still reads the failure from text.
- **Backward-compat tradeoff** — a client on an older protocol that does not read `structuredContent` sees an empty `content` for these three tools. EH's supported agent CLIs negotiate structured output; dropping the duplicate text copy is the deliberate, measured AXI #1 choice. The remaining tools still return text via `jsonResult` and are unaffected.

Round-trip, no-duplicate-text, and token-delta coverage: [`mcp-structured-output.test.ts`](../../../engine/src/mcp-structured-output.test.ts).

## Prompts / slash commands (FLUX-951)

`buildMcpServer()` registers four **MCP prompts** via `registerPrompt(...)`. Prompts surface in clients as slash commands — `/mcp__event-horizon__groom FLUX-42` in Claude Code, equivalents in Cursor and any prompts-capable client — giving EH first-class phase entry points that work **without** the client loading [`.claude/rules/event-horizon.md`](../../../.claude/rules/event-horizon.md). Registering a prompt auto-advertises the `prompts` capability; the completable `ticketId` argument auto-enables `completions`.

| Prompt | Arguments | Returns (one `user` message) |
|--------|-----------|------------------------------|
| `groom` | `ticketId` (required, completable) | The **grooming** skill-module body + a directive to `get_ticket('<ticketId>')` first and follow the workflow. When the ticket resolves, a one-line grounding header (`Ticket: <id> — <title> (<status>)`) is prepended. |
| `implement` | `ticketId` (required, completable) | The **implementation** skill-module body + the same read-first directive and grounding header. |
| `release` | `version` (required, e.g. `v1.2.0`) | The **release** skill-module body + a directive to run the workflow for `<version>`. |
| `rebase-board` | — | A short hand-authored instruction: survey with `list_tickets`, then emit ONE [`propose_board_rebase`](#propose_board_rebase) batch — never mutate the board directly. |

Key properties:

- **Single source of truth — no drift.** The three phase bodies are read at runtime from `.docs/skills/event-horizon-<module>.md` (via `resolveSkillSourceRoot()`), frontmatter stripped with `gray-matter`. Editing a skill module changes the prompt output; nothing is re-authored inline. `rebase-board` is the one hand-authored exception because its detailed ritual already lives in the `propose_board_rebase` tool description the client carries anyway.
- **Memoized at module scope.** `buildMcpServer` runs per connection, so module bodies are cached in a module-level `Map` — the file is read once per engine process, not once per connect. Read **failures are not cached**: a missing/unreadable module logs a warning and the prompt returns a short fallback message (the server never crashes and the connection never errors); a repaired file is picked up on the next invocation.
- **`ticketId` completion.** `completion/complete` on `groom`/`implement` returns active (non-terminal, non-scratch) ticket ids matching the typed value case-insensitively against id or title, capped at 20 — the same "active" notion as `list_tickets` (`getTerminalStatuses()`).

Coverage (list, get, frontmatter-stripping, fallback-free grounding, completion filtering): [`mcp-prompts.test.ts`](../../../engine/src/mcp-prompts.test.ts).

## Tool index

| Tool | Category | Mutates? |
|------|----------|----------|
| [`get_ticket`](#get_ticket) | Read | — |
| [`get_session_log`](#get_session_log) | Read | — |
| [`list_tickets`](#list_tickets) | Read | — |
| [`get_board_config`](#get_board_config) | Read | — |
| [`get_board_state`](#get_board_state) | Read | — |
| [`propose_board_rebase`](#propose_board_rebase) | Orchestrator (propose) | — |
| [`delegate_to_agent`](#delegate_to_agent) | Orchestrator (delegation) | spawns child session |
| [`delegate_parallel`](#delegate_parallel) | Orchestrator (delegation) | spawns child sessions |
| [`get_project_group`](#get_project_group) | Read | — |
| [`group_doc`](#group_doc) | Group docs — Read/Write | yes (submit/delete) |
| [`extract_ticket`](#extract_ticket) | Mutation (gated) | yes (CONFIRM) |
| [`merge_tickets`](#merge_tickets) | Mutation (gated) | yes (CONFIRM) |
| [`create_ticket`](#create_ticket) | Mutation | yes |
| [`update_ticket`](#update_ticket) | Mutation | yes |
| [`change_status`](#change_status) | Mutation | yes (enforced) |
| [`start_plan_review`](#start_plan_review) | Mutation (spawns a session) | yes |
| [`archive`](#archive) | Mutation | yes |
| [`add_note`](#add_note) | Mutation | yes |
| [`publish_artifact`](#publish_artifact) | Mutation | yes |
| [`finish_ticket`](#finish_ticket) | Lifecycle (atomic) | yes |
| [`branch`](#branch) | Branch | yes (delete) |
| [`delegate`](#delegate) | Delegation | — |
| [`permission_prompt`](#permission_prompt) | Internal (gating) | — |
| [`ask_user_question`](#ask_user_question) | Interaction (blocking) | — |

> **FLUX-882 consolidation:** several single-op tools were folded into action/type-dispatched tools (hard cut — old names removed, no aliases). See the [migration map](#flux-882-tool-consolidation-migration) at the end of this page.

---

## Read tools

### `get_ticket`

Read a ticket by ID. Returns an **agent digest**, not the raw file: history is digested and windowed so heavily-worked tickets stay a few KB instead of 100k+ chars.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | e.g. `FLUX-42` |
| `historyLimit` | number | no | Max history entries returned (default 20) |
| `expand` | string[] | no | History entry `id`s to return in FULL (un-collapse). Pass the `id` shown on a `collapsed` entry when its summary isn't enough. |
| `fullHistory` | boolean | no | Return all history uncollapsed. Discouraged — re-inflates context; prefer `expand`. |
| `fullBody` | boolean | no | Return the full `body` even when it is oversized. By default a very large body is truncated with a recoverable size hint (FLUX-879); normal bodies are never truncated. |

**Output:** returned as `structuredContent` (typed JSON; the text `content` block is empty — see [Structured output](#structured-output-flux-950)) — full frontmatter + `body` + digested `history`. The internal `_path` field is stripped. Digest rules (`serializeTaskForAgent` in [`task-store.ts`](../../../engine/src/task-store.ts), `digestHistoryForAgent` in [`history.ts`](../../../engine/src/history.ts)):

- `agent_session` entries lose their `progress[]` array and gain a `progressCount` instead — fetch the raw log via [`get_session_log`](#get_session_log) when needed. All other fields (`sessionId`, `status`, `outcome`, `startedAt`, `endedAt`, …) are preserved.
- `status_change` entries are dropped from the digest (the current status is already in the frontmatter); `comment` and `activity` entries pass through.
- **Summary-gated collapse:** older `comment`/`activity` entries that carry an agent-written `summary` **and an `id`** are returned collapsed — `{ type, user, date, summary, id, collapsed: true }` instead of the full body. Kept full: the last `commentDigest.keepRecent` (config, default 3) entries, any `pin: true` entry, any entry without a summary (never force-truncated), and any entry without an `id` (couldn't be recovered). `collapsedCount` reports how many were collapsed; fetch a collapsed entry's full text with `expand: ["<id>"]` (or `fullHistory: true`).
- Older `agent_session` entries are likewise collapsed to their `outcome` (shown as `summary`), keeping `sessionId` — recover the full session via [`get_session_log`](#get_session_log)`(ticketId, sessionId)`, **not** `expand` (collapsed sessions carry `sessionId`, not `id`).
- **Temporal supersession collapse** (FLUX-811): a `comment`/`activity` entry explicitly superseded by a **later** entry (via that entry's `supersedes: ["<id>"]`) collapses to `{ type, user, date, supersededBy: "<superseder-id>", summary?, id, collapsed: true }` — **independent of the recent-window** (it collapses even when recent, because a dead decision is noise regardless of age), recoverable via `expand: ["<id>"]`. **Guardrail:** an *agent*-authored supersession never collapses a `pin: true` or user-authored target; that target stays full and instead gains an advisory `supersededByAdvisory: "<superseder-id>"` flag. See [ticket-schema → supersedes](ticket-schema.md#per-type-fields).
- Only the most recent `historyLimit` entries are returned; when older ones are omitted, the response includes `olderHistoryEntries: <count>`.
- **Oversized `body` truncation** (FLUX-879, AXI #3): the `body` is returned whole until it exceeds a generous limit (`AGENT_BODY_LIMIT`, 12k chars in [`task-store.ts`](../../../engine/src/task-store.ts) — normal plan/AC bodies are never touched). Beyond that, the head is kept and a recoverable size hint is appended (`…[N of M body chars omitted … pass fullBody:true …]`), with `bodyTruncated: true` and `bodyOmittedChars: <count>` signalled top-level. Pass `fullBody: true` to get the whole body. Targets only pathological bodies that would otherwise dominate the payload on every read.
- Attached `cliSession`/`cliSessions` summaries are the list-scoped set with `liveOutput` truncated to a short tail, and slimmed for agents: `args` (which embeds the full launch prompt — i.e. the ticket body again), `command`, and `pid` are dropped; `argsChars` preserves a size hint.
- **Recent user comments are always surfaced** (FLUX-480): a top-level `recentUserComments` array holds the last `commentDigest.recentUserComments` (config, default 3) **user-authored** `comment` entries — scanned from the *full* history, so a user comment that aged past the window is never silently dropped. Authorship is heuristic: agents write `user: 'Agent'` (the canonical marker) or a model/framework display name; everything else is treated as a user (the bias is to never hide user intent). Cheap flags `hasUserComments` (always present) and `lastUserCommentAt` accompany it so routing/preview consumers can read them without pulling history.
- **Launch focus persists across sessions** (FLUX-480): when a session is launched with a `focusComment`, the engine records a small `activity` entry carrying a `launchFocus` field (the clean focus text only — never the full launch prompt, which FLUX-473 keeps out of the digest). The digest surfaces the most recent one as top-level `launchFocus`, with `hasLaunchFocus: true`.

The REST detail endpoint (`GET /api/tasks/:id`) is unaffected and still returns the full history for the portal.

**Errors:** `Ticket <id> not found`.

```jsonc
// example call
{ "tool": "get_ticket", "input": { "ticketId": "FLUX-42" } }
```

### `get_session_log`

Read the full progress log of **one** past agent session on a ticket. This is the escape hatch for the session digest in `get_ticket` — use it only when investigating what a specific prior session did, not as routine context.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | |
| `sessionId` | string | yes | From a `get_ticket` `agent_session` history entry |
| `tail` | number | no | Return only the last N progress entries |

**Output:** the full `agent_session` history entry including `progress[]`. With `tail`, `progress` holds the last N entries and `omittedProgressEntries` reports how many were skipped. Sessions finished after progress compaction shipped store milestones + a `finalMessage` field rather than raw output chunks (`originalProgressCount` shows the pre-compaction length) — see [Ticket Schema](ticket-schema.md).

**Errors:** `Ticket <id> not found`; `Session <sessionId> not found on <id>. Known sessions: …` (lists valid session IDs).

### `list_tickets`

List or filter tickets. **Active-by-default and bounded (FLUX-489):** a no-filter call no longer dumps the whole board (~480 rows) into context — it returns only non-terminal tickets and caps the result, attaching a note whenever rows were omitted so the truncation is never silent.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | string | no | Filter by status name. An explicit status **overrides the active-default screen** — pass `status: 'Done'` (or `Released`/`Archived`) to list terminal tickets. |
| `assignee` | string | no | Filter by assignee |
| `tag` | string | no | Ticket must include this tag |
| `priority` | string | no | One of: `Critical`, `High`, `Medium`, `Low`, `None` |
| `search` | string | no | Case-insensitive substring match over ticket **id + title**. |
| `active` | boolean | no | Default **true**: with no explicit `status`, return only **non-terminal** tickets (exclude `Done`, `Released`, `Archived`). Set `false` to include terminal statuses. |
| `limit` | number | no | Max rows returned. Default **40**. Ignored when `includeAll` is true. |
| `includeAll` | boolean | no | Escape hatch — return every matched row, ignoring both the active-default screen and the limit. |

**Output:** returned as `structuredContent` (the text `content` block is empty — see [Structured output](#structured-output-flux-950)). Always the object envelope `{ tickets: [...], note? }` — `structuredContent` must be an object, so the success shape is never a bare array (FLUX-950). Each row is a summary `{ id, title, status, priority, effort, assignee, tags }`; bodies and history are not included — use `get_ticket` for full content.

When rows are omitted — by the active-default screen or by the `limit` — the `note` reports how many terminal tickets were hidden and/or `Showing N of M matched`, plus how to widen the call (`includeAll:true`, raise `limit`, or pass an explicit `status`). This keeps the new default lean **and** discoverable — a bounded result is never silently truncated (FLUX-489).

On **zero matches** it returns a definitive empty state `{ tickets: [], note }` that echoes the active filters (AXI #5, FLUX-878) — e.g. `No tickets match status=Done, tag=mcp.` — so an agent can tell "the filter matched nothing" from "I queried the wrong field." (`list_available_agents` does the same on an empty roster: `{ agents: [], note }`.)

### `get_board_config`

Read board configuration.

**Input:** none.

**Output:** returned as `structuredContent` (the text `content` block is empty — see [Structured output](#structured-output-flux-950)): `{ statuses, projects, tags, priorities, users, requireInputStatus, readyForMergeStatus }`. `statuses` merges visible columns and hidden statuses.

This is an **agent-facing projection** (FLUX-928), trimmed because the orchestrator reads it every session and the result re-bills each turn: `tags` is a bare `string[]` of tag names (the Tailwind `color` class is dropped), and `priorities` is `{ name, icon }[]` (the `color` is dropped). The handler **clones** these from `configCache` and never mutates it — the portal/REST `GET /api/config` path still returns the full config (tags as `{ name, color }`, priorities with `color`) with colors intact.

### `get_board_state`

Live snapshot of board activity for the **orchestrator** (FLUX-604) — the *pull* half of its situational awareness. Backs the `__board__` board-scoped chat; usable from any session.

**Input:** none.

**Output:** `{ activeSessions, statusCounts }` (from `GET /api/board/state`, [`engine/src/index.ts`](../../../engine/src/index.ts)):

- `activeSessions` — one entry per currently-running CLI session: `{ taskId, status, phase, role, label, activity }` (`activity` is the session's `currentActivity`, e.g. *"Editing"*). Sourced from `getAllActiveSessions()` in [`session-store.ts`](../../../engine/src/session-store.ts).
- `statusCounts` — `{ <status>: <count> }` over all cached tickets.

Read-only and side-effect-free — a snapshot, not a subscription. The orchestrator calls it to see the field before dispatching work (`start_session`) or to check on running sessions.

### `propose_board_rebase`

The **board-rebase ritual** (FLUX-659) — the orchestrator's structured way to *propose* a batch of board restructurings the human approves in one pass, instead of mutating the board directly. **Hard rule: the orchestrator proposes, never silently restructures** — nothing applies until the user clicks *Apply approved*.

**Input:** `{ items: Array<{ kind, targets, summary, rationale?, newStatus?, phase?, into? }> }`, where:

- `kind ∈ promote | fold | archive | dispatch | status | leave` — `promote` extracts a chat/turns into a new card ([FLUX-656](../../../engine/src/board-rebase.ts) `extract_ticket`); `fold` merges a stream into another (FLUX-657 `merge_tickets`); `archive` retires the ticket(s); `dispatch` starts a phase session; `status` moves a ticket; `leave` keeps it in the orchestrator thread (the safe default — never drop an item).
- `targets` — ticket id(s) the item acts on (for `fold`, the source stream(s)).
- `summary` / `rationale` — shown in the approval panel; `rationale` is also recorded as a comment when applied.
- `newStatus` (for `status`), `phase` (for `dispatch`), `into` (for `fold`).

**Behavior:** **fire-then-resolve** — POSTs to [`/api/board/board-rebase`](rest-api.md), which **parks** the batch and broadcasts `board-rebase-proposed` ([realtime channels](realtime-channels.md)), then **returns immediately** (unlike [`permission_prompt`](#permission_prompt), which blocks the CLI synchronously). The portal renders the batch in the orchestrator dock with a per-item toggle (default-checked) + *Apply approved* / *Dismiss*; applying POSTs the approved subset to `/api/board/board-rebase-resolve`, which executes each approved item via the **verb registry** in [`engine/src/board-rebase.ts`](../../../engine/src/board-rebase.ts) and broadcasts `board-rebase-resolved`.

**Verb registry (v1):** all verbs run live — `leave` / `status` / `archive` / `dispatch`, plus `promote` ([FLUX-656](../architecture/code-map.md) `extractTicket()`) and `fold` (FLUX-657 `mergeTickets()`), both now registered. Their turn-slicing rests on the FLUX-658 substrate.

**Teeth:** the mutating verbs `change_status`, `archive`, `extract_ticket`, and `merge_tickets` are in the [`permission_prompt`](#permission_prompt) **Confirm** tier, so a *direct* orchestrator call to mutate is gated even if it bypasses this ritual — "never silently restructure" is enforced by the gate, not just the prompt.

### `delegate_to_agent`

Spawn one specialist [orchestration persona](../../../engine/src/orchestration-personas.ts) as a child session, block until it reaches a terminal state, and return its output. Used by supervisor/lead personas to fan work out to specialists.

**Input:** `{ ticketId, personaId, task, effort?, model?, timeout? }`

- `personaId` — a persona id from [`list_available_agents`](#list-available-agents) (built-in or custom).
- `task` — clear scope/expected-output for the delegate.
- `effort` — `low | medium | high` (default `medium`).
- `model` (**FLUX-482**) — optional per-call model override for *this* delegate, a literal CLI model name (e.g. `"sonnet"`, `"opus"` on Claude; `"flash"` on Gemini). **Highest precedence** among the delegate-model overrides, on **all three frameworks** (FLUX-931). Omit to let the persona/config/status-derived default apply.
- `timeout` — seconds, default 300, max 600.

**Model resolution (FLUX-482/931).** The delegate route resolves the child's model with this precedence, per-framework:

1. per-call `model` param (above) — a literal model name for whichever framework the board runs on,
2. `persona.modelTier` — built-in personas now carry the generic `'cheap'` tier on **search / grooming / doc-sync / review-reading** roles (e.g. `context-scout`, `planner`, the review reviewers, `docs-auditor`); **code-writing personas** (`implementer`, `test-engineer`, `dev-lead`, `finalizer`) carry **no** tier and keep the strong model. A tier resolves to a concrete model per-framework (`TIER_MODELS` in [`agents/types.ts`](../../../engine/src/agents/types.ts): claude→`sonnet`, gemini→`flash`; copilot has no built-in cheap alias yet, so a cheap-tier persona on a Copilot board falls through to step 3),
3. `integrations.<claudeCode|geminiCli|copilotCli>.delegateModel` config default for the board's framework (empty by default = no override),
4. the existing **status-derived** grooming/implementation model.

With no config or persona override, default behavior is unchanged except for the personas deliberately set to the cheaper tier. The persona's `phase` is also threaded onto the child so its prompt and MCP-server scoping match the delegated role.

> **All three frameworks (FLUX-931).** `session.model` — the channel the resolved model above is threaded onto — is now honored by every adapter (`session.model || selectedModel` in claude-code.ts/gemini.ts/copilot.ts), so the delegate route resolves per-framework instead of gating to Claude. Gemini validates the resolved model against its own known-models list — an unrecognized name (shouldn't happen via `TIER_MODELS`/config, only possible via a bad per-call `model` param) is dropped to no `--model` flag at all, same guard a manually-configured `geminiCli.groomingModel`/`implementationModel` already gets; Copilot has no such validation.

> FLUX-882 will later merge `delegate_to_agent` + `delegate_parallel` into a single `delegate` tool; the model-override contract above is designed to carry forward unchanged.

### `delegate_parallel`

Spawn several specialists **simultaneously**, wait for all to finish, return each result. Use for independent perspectives (e.g. fan-out review).

**Input:** `{ ticketId, delegations: Array<{ personaId, task, effort?, model? }>, timeout? }` — each delegation entry takes the same `model?` per-call override (and same resolution precedence) as [`delegate_to_agent`](#delegate_to_agent); `timeout` applies to all.

### `get_project_group`

Read the multi-repo group when one is configured (a committed `group.json` in the workspace root — see [Multi-Repo Groups](../architecture/multi-repo-groups.md)).

**Input:** none.

**Output (group configured):**

```jsonc
{
  "configured": true,
  "name": "my-product",
  "members": [
    {
      "name": "frontend",        // stable, immutable key + doc path prefix
      "role": "app",
      "remote": "https://…/frontend.git", // canonical machine-independent identity
      "path": "C:/…/frontend",     // resolved local checkout (default ../<name>, or group.local.json override)
      "pathExists": true,
      "testCommand": "npm test"   // omitted when not set
    }
  ]
}
```

**Output (no group):** `{ "configured": false, "message": "No multi-repo group is configured …" }`. This is a normal result, not an error — single-repo workspaces always get `configured: false`.

Read-only and side-effect-free: it reflects the group context loaded by `activateWorkspace` ([`group.ts`](../../../engine/src/group.ts)); it does not re-scan repos. `pathExists` is re-checked live on each call (a single stat per member), so it reflects whether a member is checked out *now* — not a stale load-time snapshot.

### `group_doc`

Read or write the shared group docs (the cross-project knowledge base). One tool dispatched by `action`; works from any workspace — **parent or bound member** — because both resolve the store via `activeGroupStoreDir()` ([`task-store.ts`](../../../engine/src/task-store.ts)). The two write actions (`submit`/`delete`) commit on `flux-group-docs` in the parent's canonical store and fan out to all members. **(FLUX-882: merged `list_group_docs` / `read_group_doc` / `submit_group_doc` / `delete_group_doc`.)**

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | `'list'` \| `'read'` \| `'submit'` \| `'delete'` | yes | Which group-doc operation to run. |
| `path` | string | conditional | Required for `read`/`delete` (full doc path incl. group prefix, e.g. `"Product/features/payments-api"`). For `submit`: store-relative path **without** the group prefix and **without** `.md` (e.g. `"features/payments-api"`); no `..`, no absolute paths. |
| `title` | string | conditional | `submit` only — document title (prepended as H1). |
| `body` | string | conditional | `submit` only — full markdown body (title heading not included). |
| `message` | string | no | `submit` only — git commit message; auto-generated when omitted. |

**Outputs by action:**

- `list` — `{ docs: [{ path, title, directory }], label }`. Empty store: `{ docs: [], message: "No group docs found …" }`. No group: `{ docs: [], message: "No group configured …" }` (not an error).
- `read` — `{ path, title, body, directory }`.
- `submit` — `{ applied, committed, pushed, failed, members: [{ name, ok, diverged?, error? }] }`. The `members` array reports per-member fan-out outcomes.
- `delete` — `{ deleted, committed, pushed, failed, members }`.

**Errors:** `path is required for action "<action>"` (validation); `Group doc '<path>' not found. Use group_doc action:"list" to see available paths.`; `No group writer is available …` (submit/delete when the workspace is neither a parent nor a bound member); `'<path>' is not a valid group doc path …` (delete, when the path doesn't start with the group prefix).

---

## Mutation tools

All mutation tools:

- Validate frontmatter against [`schema.ts`](../../../engine/src/schema.ts) before writing.
- Set `updatedBy` to `'Agent'` (or the provided `user`/`author`).
- Auto-register any new tags into board config (`autoRegisterUnknownTags`).
- Broadcast an SSE `taskUpdated` or `taskCreated` event so the portal reacts live.

### `create_ticket`

Create a new ticket. **Pass `parentId` to create it as a linked subtask** (FLUX-882 — absorbed the old `create_subtask` tool).

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `title` | string | yes | — |
| `parentId` | string | no | — — when set, the new ticket is created as a linked subtask of this parent |
| `status` | string | no | `Todo` |
| `priority` | string | no | `None` |
| `effort` | string | no | `None` |
| `assignee` | string | no | `unassigned` |
| `tags` | string[] | no | `[]` |
| `body` | string | no | `''` |
| `author` | string | no | `Agent` |

**Output (no parent):** `{ id, title, status, nextSteps }`. **Output (with `parentId`):** `{ id, parentId, title, status, nextSteps }`. `nextSteps` is a terse AXI #9 contextual-disclosure hint pointing at the likely next move (`start_session` / `update_ticket`). When `body` exceeds 10,000 chars the output also carries a `warning` field — the write is accepted, but the agent is nudged to keep bodies a concise plan and move bulk material to `.docs/`.

**Side effects:** assigns the next `<projectKey>-N` id, writes `.flux/<id>.md`, seeds a creation activity entry in history. **With `parentId`** (the merged subtask path): the child is created with `skipBroadcast`, then linked into the parent's `subtasks` array via a TOCTOU-safe read-modify-write, and only then is `taskCreated { id, parentId }` broadcast — so a failed parent write never emits an event for an orphan child.

**Errors:** `Parent ticket <id> not found` (when `parentId` is unknown); `Workspace is activating, please retry`; `Schema validation failed: …`.

### `extract_ticket`

The **promotion gate** (FLUX-656). Carve a topic-slice out of a conversation stream — the
orchestrator thread `__board__` by default — into a NEW ticket. A chat starts as turns in the
orchestrator thread and *materializes into a card only when it crosses a threshold*; promotion
is **extraction, not 1:1** — address the slice by `seq` range on the source stream.

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `from` | string | no | `__board__` |
| `fromSeq` | number (int) | yes | — |
| `toSeq` | number (int) | yes | — |
| `title` | string | yes | — |
| `priority` | string | no | `None` |
| `effort` | string | no | `None` |
| `tags` | string[] | no | `[]` |
| `body` | string | no | `''` |

**Output:** `{ id, title, turnsExtracted, sourceConsumed?, consumeError? }` — `sourceConsumed`
is `true` when a scratch source was consumed (see below); `consumeError` is set if that
best-effort archive failed (the promote still stands).

**Side effects:** creates the new ticket (`create_ticket` path) and appends one `extract` op to
the curation op-log (`<fluxDir>/transcripts/_curation-ops.jsonl`). The source turns are **never
moved or copied** — the new card's transcript re-derives the slice from substrate + op-log, so
extract is additive and un-doable (remove the op → the view reverts).

**Scratch exception (FLUX-1249):** the one case where promotion is *not* additive. When the
source is a `kind:"scratch"` disposable scratchpad, promotion **consumes** it — the scratch is
tombstoned (a pinned comment pointing at the new ticket + a `mergedInto` pointer) and archived,
mirroring how [`merge_tickets`](#merge_tickets) consumes its sources. A scratch is disposable, so
leaving it live would surface every new scratch turn in **both** cards; consuming it leaves
exactly one live card. Archiving (never deleting) keeps the promoted card's live re-derivation
intact — `sliceTurns` reads the untouched substrate transcript. Consume is **best-effort**: if
the archive fails the promote still succeeds (`consumeError` is returned). Promoting any
non-scratch source (e.g. `__board__`, a real ticket slice) stays purely additive.

**Gating (human-approval invariant):** `extract_ticket` is in the **CONFIRM** permission tier
— a direct call by a gated session prompts the human. The orchestrator does not call it
autonomously; it proposes a `promote` item via [`propose_board_rebase`](#propose_board_rebase),
and the approved item runs through the same `extractTicket()` engine path.

**Errors** (validated before any ticket is created — no partial state): inverted range
(`fromSeq > toSeq`), non-finite seqs, unknown source stream, or an empty slice → `extract: …`.

### `merge_tickets`

The **fold gate** (FLUX-657) — the *inverse* of `extract_ticket`. Fold several tickets/chat-streams
into ONE survivor effort, for when *"three chats are really one effort."* Extract carves a slice
*out* into a new card; merge folds whole streams *in* to an existing one.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `into` | string | yes | Survivor ticket the sources fold into |
| `from` | string[] | yes | Source ticket/stream ids to fold in (non-empty; must exclude `into`) |

**Output:** `{ into, merged, turnsFolded, archiveFailures }` — `merged` is the deduped source list,
`turnsFolded` the total turns gathered from all sources, `archiveFailures` any source whose
tombstone/archive side-effect failed (the merge op still stands; re-archive those).

**Side effects:** appends one `merge` op to the curation op-log
(`<fluxDir>/transcripts/_curation-ops.jsonl`). The survivor's transcript then **re-derives** as the
**chronological union** (`ts` order, tie-broken by `(streamId, seq)`) of its own turns plus every
`from` stream's turns; foreign turns keep their `streamId` so the projection tags them with a
`sourceStream` attribution badge. The source turns are **never moved or copied** — merge is additive
and un-doable (remove the op → the view reverts). Each `from` ticket is then **tombstoned**
(a [`mergedInto`](ticket-schema.md) frontmatter pointer + a **pinned** tombstone comment) and
**archived** (`config.archiveStatus`); **none are deleted** and their original transcripts stay intact
in the substrate.

**Gating (human-approval invariant):** `merge_tickets` is in the **CONFIRM** permission tier — a
direct call by a gated session prompts the human. The orchestrator does not call it autonomously; it
proposes a `fold` item via [`propose_board_rebase`](#propose_board_rebase), and the approved item runs
through the same `mergeTickets()` engine path.

**Errors** (validated before the op is appended / any ticket is mutated — no partial state): unknown
survivor `into`, empty `from`, self-merge (`into ∈ from`), unknown source, or a source already merged
into another effort → `merge: …`.

### `update_ticket`

Update metadata. Does **not** change status — use `change_status` for that.

| Input | Type | Notes |
|-------|------|-------|
| `ticketId` | string (required) | |
| `title`, `priority`, `effort`, `assignee`, `body`, `implementationLink` | string | omit to leave unchanged |
| `tags` | string[] | replaces the array (not a merge) |
| `parentId` | string \| null | **FLUX-1068** — (re)link an **existing** ticket under a parent. A string sets/moves the parent; `null` detaches. Omit to leave the link unchanged. |

**Output:** `Updated <id>`. When a provided `body` exceeds 10,000 chars, a soft warning is appended to the output (the write still succeeds).

**Side effects:** appends a single `activity` history entry summarizing the field changes (e.g. *"Updated title. Changed priority to High."*).

**Re-parenting (`parentId`, FLUX-1068).** Unlike `create_ticket` (which links a *brand-new* child), `update_ticket` re-links a ticket that already exists — the only MCP way to re-parent, previously a raw REST `PUT`. Setting `parentId` runs the same **bidirectional parentId ⇄ `subtasks` sync** the REST route uses (extracted into one shared helper in `task-store.ts`): the child's `parentId` is written, the new parent's `subtasks` gains the id, and any old parent's `subtasks` loses it. Passing `parentId: null` deletes the `parentId` key (not a null) and removes the child from the old parent's `subtasks`. **Guards:** self-parenting and cycles (A→B→A) are rejected before any write with a `validation_failed` error; an unknown parent id returns `not_found`.

### `change_status`

Move a ticket to a new status.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `newStatus` | string | yes |
| `comment` | string | conditional — see enforcement |
| `callerRole` | string | no — set to `"orchestrator"` or `"lead"` to bypass scatter-gather restriction |
| `reviewState` | `'approved'` \| `'changes-requested'` \| null | no — **FLUX-816.** Records the EH review verdict on the card (persisted as the [`reviewState`](ticket-schema.md) frontmatter field). A review lead passes `"approved"` when moving to `Ready` and `"changes-requested"` when moving back to `In Progress`; `null` clears it. Surfaces a review badge; distinct from the GitHub-synced `reviewDecision`. An explicit value on this call always wins over the FLUX-1089 auto-clear below. |
| `planReviewState` | `'approved'` \| `'changes-requested'` \| null | no — **FLUX-1263.** The `plan` gate's verdict, parallel to `reviewState` but for the Grooming → Todo gate (persisted as [`planReviewState`](ticket-schema.md); never overloads `reviewState`). A plan-review session passes this while leaving `newStatus` as `"Grooming"`; `null` clears it. Cleared automatically on any other move out of Grooming with no explicit value (`resolvePlanReviewStateOnMove`, mirrors the `reviewState` auto-clear below). **FLUX-1303:** an explicit value also stamps [`planReviewBodyHash`](ticket-schema.md) (the reviewed body's hash; nulled when the verdict clears) — the portal uses it to gate "Re-review plan" on the plan actually having changed. |
| `completion` | object | no — **FLUX-1147.** Optional structured completion handoff: `{ changedFiles?: string[], validation?: {command: string, passed: boolean}[], decisions?: string[], residualRisk?: string, docsUpdated?: string[] \| boolean }`. Persisted as extra fields on the same `comment` history entry this call writes (**not** ticket frontmatter — see [history entry types](ticket-schema.md)) — a machine-readable companion to the required prose `comment`, not a replacement for it. Attached only when a `comment` entry is actually written by this call (i.e. it's dropped if `comment` is omitted on a transition where it isn't required). Accepted regardless of `newStatus` (not gated to `Ready`). **Best-effort, never a gate:** malformed or oversized fields are silently dropped/truncated (`sanitizeCompletion` in `engine/src/completion-payload.ts` — caps: 200 `changedFiles`, 50 `validation`, 20 `decisions`, ~2000-char `residualRisk`, ~8KB total serialized) — a garbage payload can never fail schema validation or block the status move. An explicit empty object `{}` is stored as-is (renders nothing extra in the portal). |
| `noDiffExpected` | boolean | no — **FLUX-1267.** `Ready` transitions only. Explicit caller acknowledgment that this ticket's scope genuinely produces no code diff (a verification/investigation/spike ticket) — see the FLUX-730 enforcement bullet below for exactly what it lifts. |

**Output:** a confirmation line (`<id> moved to <status>`). On moves to `In Progress` / `Todo` / `Grooming` / `Ready` it appends a terse AXI #9 contextual-disclosure next-step hint (FLUX-877) — e.g. a `Ready` move points at `finish_ticket`; terminal/unknown statuses get no hint. The `Require Input` route returns its own hint to wait for the user.

**Enforcement:**

- Transitioning **to** `Require Input` requires `comment` (the question to ask the user).
- Transitioning **to** `Ready` requires `comment` (the completion summary), unless `config.requireCommentOnStatusChange === false`.
- **Commit-before-Ready for worktree branches (FLUX-730).** Transitioning **to** `Ready` is **refused** (error result, status unchanged) when the ticket's branch has a dedicated worktree **and** the branch has **0 commits ahead** of the default branch — an uncommitted worktree can never open a PR, so the move would land a silent "Ready, no PR". The error distinguishes "work done but uncommitted" (worktree has changes) from "no changes yet" and tells the agent to commit then retry. **Scoped to worktree branches only:** plain-branch tickets keep the soft warning (notification + activity, move still proceeds), and branchless tickets are unaffected (they legitimately stay uncommitted until `finish`). On a successful `Ready` move for a branch with commits, the engine pushes and opens the PR (`implementationLink` + `open-pr` swimlane).
  - **Zero-diff escape hatch (FLUX-1267).** A ticket whose scope legitimately produces no code diff (verification/investigation/spike) has no work to commit and would otherwise be refused forever, tempting a skip straight to `Done` that bypasses this review stop entirely. Passing `noDiffExpected: true` lifts the refusal **only when the worktree is also clean** (0 uncommitted changes, per `worktreeUncommittedCount`) — if there ARE uncommitted changes sitting in the tree, the refusal still fires with its normal message, since that contradicts a zero-diff claim. When acknowledged, no PR is opened (there is nothing to merge); the move records a plain `Zero-diff ticket acknowledged…` activity entry instead of the PR-creation attempt / "commit needed" warning.
- **Dirty-root backstop for engine-driven switches (FLUX-741).** Sibling to the commit-before-Ready discipline, but for the **main/root checkout** rather than worktrees. Whenever the engine *must* switch or fast-forward the root tree off a branch during post-merge cleanup (`cleanupMergedBranch`'s `git checkout <default>` and `syncDefaultBranch`'s in-place `merge --ff-only`), it first **stashes any uncommitted/untracked root work** (`stashDirtyTree`, reusing the detach stash pattern) so the switch can never silently discard it — the root-clobber that lost work in the FLUX-734/739 incidents. The stashed work stays recoverable (`git stash apply <ref>`) and the ref is surfaced in a notification. Worktree mutation points are already guarded (`removeTaskWorktree` refuses a dirty tree; `detachTaskWorktree` stashes); this closes the gap on the root tree only. The complementary fix is **worktree-by-default** (see `branch` `action:'create'`): isolating agent sessions in their own worktree means the shared root is rarely the place edits live in the first place.
- The `Require Input` / `Ready` status names are read from `configCache.requireInputStatus` / `readyForMergeStatus` and may be renamed in board config.
- **Stale-`reviewState` clear on leaving Ready (FLUX-1089).** Transitioning **out of** `Ready` (to anything else) clears a prior `reviewState` unless this same call passes an explicit one (`resolveReviewStateOnMove` in `mcp-server.ts`) — an `approved` (or stale `changes-requested`) verdict from the last review no longer describes a ticket that's active work again. The FLUX-569 changes-requested unwind (`bounceMembersToInProgress` in `pr-tickets.ts`, which bounces a PR's Ready members straight to `In Progress` without going through this tool) applies the same clear at its own `updateTaskWithHistory` call site.
- **Scatter-gather guard:** If the ticket has 2+ active sessions where at least one has `patternPosition: 'step'`, status changes are rejected unless `callerRole` is `'orchestrator'` or `'lead'`. This prevents individual reviewers from moving the ticket while peers are still reviewing. Affected sessions should use `add_note` (`type: 'comment'`) instead.
- **Plan-review gate redirect (FLUX-1263, loop shape updated FLUX-1288).** A `Grooming` → `Todo` move is **intercepted** — the status stays `Grooming` — when the resolved `plan` gate (`config.gatePolicy.boardDefault.plan`, or the ticket's own `gatePolicyOverride.plan`) is `auto` or `auto-then-you` **and** no `planReviewState` verdict has been recorded yet (`evaluatePlanGateTrigger`, pure). The plan-review gate runner (`gate-runner.ts`) starts instead, via `resolvePlanGateMode` (`mcp-server.ts`): `auto` and `auto-then-you` both loop review → revise → re-review up to the shared retry cap on a `changes-requested` verdict — they differ only on an `approved` verdict, where `auto` moves the ticket to Todo itself (bypassing this tool) and `auto-then-you` instead stops and flags a human to confirm; either mode parks on retry-cap exhaustion. Any `comment` on the intercepted call is still recorded before the redirect. Once a verdict already exists (the `auto-then-you` loop stopped on approval, or a manual [`start_plan_review`](#start_plan_review) ran under `you`), the next `Grooming` → `Todo` call goes through normally and clears it — that call **is** the human's confirm. The `you` gate value never intercepts. **FLUX-1379:** an XS/S ticket never reaches this trigger at all when `config.planGateSkipSmall` (default `true`) is on — the direct move proceeds and records an audit `activity` entry noting the skip; the lint bullet below still runs first regardless.
- **Deterministic pre-gate plan lint (FLUX-1379).** Immediately before the redirect above — for **every** agent `Grooming` → `Todo` move, regardless of gate value (including `you`, and including the post-approval confirm move) — `change_status` runs a pure, dependency-free lint (`models/plan-lint.ts`) over the ticket body when `config.planLint` (default `true`) is on: a missing leading `> **TL;DR**` blockquote once the body is substantial, an M+ ticket with no `## Acceptance criteria` checklist or an essentially-empty body, an L/XL ticket with no `## Recommended Tests`/`## Test plan` heading, or an unset effort. Any of these **bounce** the call outright — `errorResult`, the ticket stays exactly where it was, the complete list of findings comes back in one response, and no LLM session is ever spawned. A missing artifact revision on an M+ plan is a separate **warn**-only finding — never blocks, instead injected into the plan-review session's focus text (see `gate-runner.ts`'s `planReviewFocus`) once the gate itself runs. Portal/REST status moves never reach this handler and are never linted.

**Output:** `<id> moved to <status>`.

**Side effects:** appends a `comment` entry when one is provided, plus a `status_change` entry recording the transition.

- **Stale parked-session reaping (FLUX-721).** On a genuine **forward** transition (any `newStatus` other than `Require Input`, where parking is legitimate), the ticket's sessions still parked at `waiting-input` on an **earlier phase** are terminalized (`reapStaleParkedSessions`). This prevents grooming/implementation sessions left parked after the ticket advances from lingering as zombies that gate merges (the [`POST /:id/pr/merge`](rest-api.md) Tier-2 guard) or 409 new session starts. The live calling agent (`running`) and the persistent per-ticket **`chat`** session (`phase: 'chat'`) are preserved. An `activity` entry records any reap.

### `start_plan_review`

**FLUX-1263.** Manually trigger ONE plan-review pass on a `Grooming` ticket right now — the `plan` gate's explicit human-invoked entry point. Use it under the `you` gate value (which never auto-triggers) or any time an extra look is wanted before moving `Grooming` to `Todo`. Runs exactly one pass regardless of gate value (never loops) and records its verdict to [`planReviewState`](ticket-schema.md); it does not move the ticket itself — a later `change_status` to `Todo` goes through once the verdict is recorded (see the redirect note above). **FLUX-1379:** short-circuits on the same deterministic lint the `change_status` guard runs (when `config.planLint` is on) — a plan with bounce findings returns the list instead of dispatching a session.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes — must currently be in `Grooming` |

**Errors:** ticket not found; not currently `Grooming`; a plan-review pass is already in flight on this ticket; the ticket is owned by an active Furnace batch (which wins — the gate never double-drives a Furnace-owned ticket).

**Output:** a confirmation line noting whether the review session dispatched immediately or is waiting for a session slot.

### `archive`

Archive or unarchive a ticket. One tool dispatched by `action` (FLUX-882 — merged `archive_ticket` / `unarchive_ticket`). Archiving is the reversible alternative to deletion: history is preserved and the ticket can be restored. **There is no hard-delete MCP tool** — prefer archiving.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | |
| `action` | `'archive'` \| `'unarchive'` | yes | Whether to archive or unarchive. |
| `comment` | string | no | `archive` only — reason for archiving (recorded as a `comment` entry). |
| `toStatus` | string | no | `unarchive` only — status to restore to (default `Todo`); must not be the archive status. |

**Behavior:**

- `archive` → moves the ticket to the **Archived** status (`config.archiveStatus`, default `Archived`). No-op-safe: returns `<id> is already <Archived>` if already archived. Clears any active swimlane (and dismisses its notifications) so the archived ticket doesn't carry a stale blocked flag. Reaps stale parked **phase** sessions (`waiting-input`, non-`chat`) so an archived ticket leaves no session zombies behind (FLUX-721). Output: `<id> archived (moved to <Archived>)`.
- `unarchive` → moves the ticket out of the Archived status to `toStatus` (default `Todo`). Output: `<id> unarchived (moved to <toStatus>)`. **Errors:** `<id> is not archived (status is <status>).` if not currently archived.

### `add_note`

Append a note to a ticket's history. One tool dispatched by `type` (FLUX-882 — merged `add_comment` / `log_progress`): `'comment'` records a human-facing comment; `'activity'` logs an agent progress update ("agent did X"). The optional `summary`/`pin`/`supersedes` apply to both.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `type` | `'comment'` \| `'activity'` | yes — `comment` = human-facing comment; `activity` = agent progress/activity update |
| `message` | string | yes — the comment body or progress message |
| `user` | string | no — author (default `Agent`); honored for `type: 'comment'`, while `activity` is always attributed to `Agent`. **This is a caller-controlled claim, not authenticated** — any comment it writes is stamped `selfAttested` (FLUX-1271) so it can never itself satisfy the [`finish_ticket` merge-lock](#finish_ticket)'s "a human touched this" check, no matter what name is passed. |
| `summary` | string | no — a faithful summary; shown in the agent digest once the note ages past the recent window (full text via `get_ticket` `expand`). Provide for substantial notes; concise but lossless. |
| `pin` | boolean | no — never collapse this note in the agent digest (review handoffs / key decisions). |
| `supersedes` | string[] | no — ids of earlier history entries this note makes obsolete (a decision reversed/replaced). The superseded entries collapse to a one-line marker in the agent digest (still recoverable via `expand`). A `pin: true`/user-authored target is advisory-only (kept full). Set ONLY when genuinely retiring a now-wrong entry. |

**Output:** `Comment added to <id>` (type `comment`) or `Progress logged on <id>` (type `activity`).

### `publish_artifact`

Publish a self-contained HTML **artifact** (FLUX-873) so the user reasons against a concrete rendering instead of imagining it from prose. It spans **both lifecycle ends** — not grooming-only: at plan time a **grooming artifact** (mockup / architecture-flow diagram / interactive prototype), and at `Ready` a **visual recap** of the implementation diff (touched-file tree + key diff hunks + plain-language summary — FLUX-976). The tool is **not status-gated**; it accepts any `ticketId` at any point in the lifecycle. Whether to emit is an **agent heuristic** (no tag gate): emit for UI/UX, architecture, or "shape of the thing" work; skip bug fixes / XS-S / backend plumbing; default OFF when unsure. The grooming skill and the implementation skill's "Visual Recap Artifact" section carry the full heuristics; a recap tags its `title`/`note` with "recap" so the portal labels the panel accordingly. The orchestrator skill's Rich Artifacts → **Craft** subsection (FLUX-1398) carries the quality rules — viewport fidelity, real test data, options-with-recommendation, measured claims, and minimal, annotation-driven revisions.

Each call is a **new revision** (history is kept — never an overwrite). The HTML is stored in a traversal-guarded sidecar at `.flux/artifacts/{ID}/{rev}.html` (never inlined in the body) and a revision-keyed pointer (`artifacts: { latest, revisions[] }`) is written to the ticket frontmatter. The tool broadcasts `taskUpdated` + `artifactReady { ticketId, rev }` over SSE, and the portal renders the artifact in a sandboxed iframe via [`GET /api/tasks/:id/artifact`](rest-api.md).

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `html` | string | yes — a **complete, self-contained** HTML document (inline `<style>`/`<script>`; default to hand-written inline CSS). Mermaid is loadable via CDN `<script>` for diagrams; the Tailwind Play CDN is allowed but a heavy last resort, not the default — it's a full in-browser compiler that can freeze the host UI for seconds per load. Rendered in a sandboxed opaque-origin iframe with `connect-src 'none'`, so it cannot reach the portal/cookies/storage and cannot make network requests — inline everything or load from the allowed CDNs. React/TSX components render via inline React + `@babel/standalone` (transpiled in-browser under `'unsafe-eval'`) and must be self-contained — no `import` of project modules or external `.tsx` fetch (FLUX-961); the grooming skill carries the full copy-paste template. |
| `title` | string | no — short label shown above the viewer. |
| `note` | string | no — what changed in this revision / what to look at. |

**Output:** confirmation with the new revision number and the artifact route. Errors on a missing ticket, an unsafe id, or empty `html`.

---

## Lifecycle tool

### `finish_ticket`

Atomic close-out: set `implementationLink`, append a completion comment, move status to `Done`. For a **branch ticket** (with `gh` authenticated) it **merges the branch's PR** (squash) and then runs the shared post-merge cleanup (advance + master fast-forward + worktree/branch teardown, FLUX-574). The PR is normally opened at the Ready transition; if none exists at finish, finish **opens it first** (FLUX-578). Critically, if the branch's prior PR is already **MERGED or CLOSED** (a dead PR — e.g. a commit pushed *after* that PR merged, FLUX-656), finish does **not** merge onto the dead PR (which would throw "already merged" and strand the commit) — it opens a **fresh** PR and merges that instead (FLUX-741, `planFinishPr`). Only when the branch has **no commits ahead** of its base (nothing to merge) does it route the ticket to **Require Input** rather than failing on a raw merge error — **unless** the ticket is a deliberately-**folded** one (FLUX-944): if `implementationLink` already points at a **MERGED** PR on a *different* branch (a sibling ticket's PR that this ticket's deliverable was folded into), finish auto-detects that, skips opening/merging a PR of its own (there's nothing to merge on this branch, by design), and finishes straight through using that link. Non-folded empty branches (no such merged sibling link) are still guarded to Require Input. No extra param is needed — pass the sibling PR's URL as `implementationLink` as usual.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `implementationLink` | string | yes — commit hash or PR URL |
| `completionComment` | string | yes — summary of what was implemented |
| `force` | boolean | no — override the shared-PR guard (see below) |
| `completion` | object | no — **FLUX-1147.** Same optional structured completion payload as [`change_status`](#change_status) (`changedFiles`, `validation`, `decisions`, `residualRisk`, `docsUpdated`), persisted onto this call's own completion `comment` history entry. Covers the **branchless-ticket** case where `Ready` (and its own `completion` param) is skipped entirely — pass it directly here instead. Same best-effort validator, same never-blocks guarantee. |

**Output:** `<id> finished → Done (link: <url>)`.

**Side effects:**

- For a branch ticket: ensures an **OPEN** PR exists (opens a fresh one if missing **or if the existing PR is MERGED/CLOSED** — FLUX-741), squash-merges it, then runs the unified post-merge cleanup (`cleanupMergedBranch` — advance branch tickets, fast-forward master, remove worktree + delete branch, clear the `open-pr` swimlane). The post-merge cleanup stashes any **uncommitted work on the main/root checkout** before switching/fast-forwarding it, so an engine-driven branch switch can never silently discard root edits (FLUX-741, incident FLUX-734) — the work is surfaced as a recoverable stash via a notification.
- **Shared-PR guard (FLUX-569):** finishing one member of a branch shared by **non-terminal sibling tickets** is refused — merging would advance them all to Done as a one-way door (the FLUX-556/PR#6 incident). The error names the siblings; either finish/close them first, merge via the PR ticket, or re-run with `force: true` to land the whole shared PR. **PR tickets (`kind:'pr'`) are exempt** — merging a PR ticket to advance its members is the sanctioned shared-merge surface.
- **Merge-lock guard (FLUX-1264, hardened FLUX-1271, gated FLUX-1290):** for a branch ticket (including `kind:'pr'` tickets — intentional, not an oversight), refuses to merge unless the ticket's history has at least one `comment` or `status_change` entry authored by someone other than the `Agent` actor (`hasHumanGateTouch`, `models/gate-policy.ts`) — the runtime half of the merge-lock, since this is the one merge path an agent session can reach on its own initiative. Ask a human to comment on or move the ticket, then finish again; no `force` override exists for this one. `add_note`'s `user` param (fully caller-controlled, see [`add_note`](#add_note)) can no longer satisfy this check — every comment it writes is stamped `selfAttested` and ignored here regardless of the claimed author, so the same session can't call `add_note({user:'SomeHuman', ...})` then `finish_ticket` to forge a human touch in one round trip. Not a cryptographic guarantee (this is a local-first app with no real auth — a session willing to hit the REST API directly instead of the sanctioned MCP tools could still forge it), just a closed instance of the specific same-tool-call spoof. **FLUX-1290:** this whole check is now gated behind the board config's `blockAgentPrMerges` (default **`false`**) — when `false`, the check is skipped entirely and `finish_ticket` merges with no human touch required; when `true`, behavior is unchanged from the above. See [Configuration Reference](../configuration.md#block-agent-pr-merges).
- Merge failure / `gh` unavailable → bounces the ticket back to In Progress with an actionable comment (no partial Done). A branch with **no commits ahead** of its base routes to **Require Input** (FLUX-741) — there is genuinely nothing to merge, so it surfaces as a blocker rather than looping — unless it's detected as **folded** (FLUX-944, see above), in which case it finishes straight through instead.
- Writes status + link + comment in one disk write — no partial state on failure.
- Reaps stale parked **phase** sessions (`waiting-input`, non-`chat`) once the ticket is Done, so a finished ticket leaves no session zombies behind (FLUX-721).

---

## Branch tool

### `branch`

Manage the git branch for a ticket. One tool dispatched by `action` (FLUX-882 — merged `create_branch` / `get_branch` / `delete_branch`). Wraps git operations through [`branch-manager.ts`](../../../engine/src/branch-manager.ts). Branches are named `flux/<lowercased-ticket-id>-<slug>`.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | |
| `action` | `'create'` \| `'status'` \| `'delete'` | yes | Which branch operation to run. |
| `baseBranch` | string | no | `create` only — base branch (default `master`). |
| `worktree` | boolean | no | `create` only — default **`true`** (agent sessions are worktree-isolated by default). |
| `force` | boolean | no | `delete` only — force delete even if unmerged (default `false`). **Invalid for other actions** — passing it on create/status returns a `validation_failed` error. |

**`action: 'create'`** — creates the branch (and, by default, a dedicated worktree) and stores its name on the ticket. **Output:** `{ branch: "<name>", worktree?: "<path>", worktreeError?: "<msg>", nextSteps }`. **Worktree-by-default:** this is the **agent** branch-creation path, so it defaults `worktree` to `true` — every agent branch session lands in its own worktree at `<repoParent>/.eh-worktrees/<repo>-<id>` and runs isolated there, so two parallel ticket sessions never share one checkout. Pass **`worktree: false`** for the single-checkout / human-manual escape. (The portal/human "Start task" path — `POST /:id/branch` — is *separate* and keeps its own default off.) The branch is always created first, so a worktree failure (e.g. hitting the concurrency cap of 4) is reported in `worktreeError` without failing the call. See [`task-worktree.ts`](../../../engine/src/task-worktree.ts). **Errors:** ticket not found; `Ticket <id> already has branch: <name>`; git failure.

**`action: 'status'`** — **Output:** `{ name, exists, aheadCount, behindCount }`. If the ticket has no branch, returns `{ name: null, exists: false, aheadCount: 0, behindCount: 0 }`.

**`action: 'delete'`** — **Output:** `Branch <name> deleted`. Refuses to delete unmerged branches unless `force === true`. If the ticket has a dedicated worktree, the session is stopped and the worktree detached first (a branch can't be deleted while a worktree holds it checked out). As an **abandon**, any uncommitted work is preserved as a recoverable stash ref but NOT applied onto master. **Idempotent:** if the git branch is already gone (e.g. deleted by post-merge cleanup), the local delete is skipped rather than erroring, and the tool still clears the ticket's stale `branch` field — the way to detach a dead branch from a reopened ticket (FLUX-588).

> **Worktree teardown on finish:** `finish_ticket` stops the session and tears the ticket's worktree down (via detach) after the work is committed and the PR merged. If the worktree still has **uncommitted** changes, they are surfaced onto master and noted on the ticket, never discarded. The manual `POST /:id/worktree/detach` escape hatch behaves the same.

> **Subtasks (FLUX-882):** the old `create_subtask` tool is gone — create a subtask with [`create_ticket`](#create_ticket) passing `parentId`. Same atomic parent-link behavior (child created with `skipBroadcast`, TOCTOU-safe link into the parent's `subtasks` array, then `taskCreated { id, parentId }` broadcast).

---

## Delegation tool

### `delegate`

Delegate one or more tasks to specialist agents and wait for them to finish (FLUX-882 — merged `delegate_to_agent` / `delegate_parallel`). One delegation runs serially; multiple run in parallel via `Promise.allSettled`. **Always returns a JSON array**, one entry per delegation.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | The ticket the delegations are for. |
| `delegations` | array (≥1) | yes | Each: `{ personaId, task, effort?, model? }`. Length 1 = serial; >1 = parallel. |
| `timeout` | number | no | Seconds for ALL delegations (default 300, max 600). |

**Output:** `[{ persona, succeeded, status, output }, …]` — one entry per delegation, in input order. A rejected delegation yields `{ persona, succeeded: false, status: 'error', output: <reason> }`. (`model` is an optional per-delegation override — **FLUX-482/931** — honored with precedence per-call `model` > `persona.modelTier` (tier-resolved per-framework) > config `delegateModel` default > the status-derived default, on all three frameworks; see [`cli-session.ts`](../../../engine/src/routes/cli-session.ts).)

---

## Internal tool

### `permission_prompt`

**Not for agents to call directly.** Claude Code invokes this automatically when a gated session is spawned with `--permission-prompt-tool mcp__event-horizon__permission_prompt` (FLUX-605). It implements Claude Code's permission-prompt contract: given a tool that would otherwise prompt, return a synchronous decision.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `tool_name` | string | yes | The tool Claude Code wants to run (may be MCP-prefixed, e.g. `mcp__event-horizon__change_status`). |
| `input` | any | no | The proposed tool input; echoed back as `updatedInput` on allow. |

**Output:** the Claude Code permission decision — `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }` (returned as JSON text).

**Policy** (`permissionDecisionFor` in [`mcp-server.ts`](../../../engine/src/mcp-server.ts)):

- **Auto-allow** — reads and safe tools (`get_ticket`, `list_tickets`, `get_board_config`, `Read`, `Glob`, `Grep`, `WebFetch`, …) and anything not in the confirm set.
- **Confirm** — destructive ops `change_status`, `finish_ticket`, `archive`, `Bash`, the restructuring verbs `extract_ticket` / `merge_tickets` (FLUX-659 teeth), and the action-aware tools' destructive actions (below) route through a human Allow/Deny round-trip: the tool POSTs to [`/api/board/permission-request`](rest-api.md), which parks the call until a human resolves it in the portal (or 120s elapses → auto-deny). The synchronous CLI contract is satisfied by holding the HTTP response open until resolution.
  - **Decision normalization (FLUX-1026):** whatever the resolve endpoint returns, `permission_prompt` re-shapes it at the CLI boundary before forwarding so the union is always valid — a bare `{ behavior: 'allow' }` (the portal Approve POST omits `updatedInput`) becomes `{ behavior: 'allow', updatedInput: <original input> }` (the human approved running the tool *as proposed*), a deny without a message gets a default one, and a malformed/empty body falls back to a deny. Without this, a human-approved confirm-tier call forwarded an allow with no `updatedInput`, failing Claude Code's Zod union and crashing the CLI on every approval.
  - **Action-aware gating (FLUX-882, hardened FLUX-939):** the merged tools gate on their action/type param, not just the bare name, via a declarative per-tool safe-actions list (`ACTION_AWARE_PERMISSION_TOOLS`) — an action NOT in that list, including a missing `input` altogether, **confirms** (fail-safe; the original `bare === 'branch'` special-case fell through to allow when `input` was absent). `branch` auto-allows only `create`/`status` (confirm-gated on `delete` — the old `delete_branch` gate). `furnace_batch` auto-allows only `ignite`/`stop`/`resume` (confirm-gated on `discard`). `group_doc` auto-allows only `list`/`read`/`submit` (confirm-gated on `delete` — it fans out to every member repo, so it now gets the same treatment `branch` delete already had; previously auto-allowed for every action). `archive` stays confirm in **both** directions (archive + unarchive). `add_note`, `delegate`, `swimlane`, and `create_ticket` (incl. the subtask path) are auto-allow.

The confirm round-trip emits the `permission-request` / `permission-resolved` realtime events ([realtime channels](realtime-channels.md)) so the portal can show the approval prompt. Gating is per-session: see [permission mode](#permission-mode) below.

**FLUX-833 (durable record + safety net).** For a ticket-bound request (the session's `EH_CONVERSATION_ID` is a real ticket id) the round-trip is also recorded durably: `permission-prompts.ts` appends a `permission-request` transcript event when approval is raised and a `permission-resolved` event when it settles, so a cold resume shows the approval in chat history (rendered as a quiet 🛡 `permission` note — see [substrate-vs-projection §4.4](../architecture/substrate-vs-projection.md)). On **timeout** the auto-deny also raises a persistent **"Needs Action"** flag + notification on the ticket (`raiseNeedsAction`, the same net `ask_user_question` uses, FLUX-826) — so a denied-by-timeout approval no longer silently vanishes. (Durability across an **engine restart** and re-injecting a late decision are later FLUX-833 phases; today the pending entry is still in-memory.)

#### Permission mode

Sessions are spawned in one of two modes (`permissionArgs` in [`agents/claude-code.ts`](../../../engine/src/agents/claude-code.ts)):

- **`gated`** → `--permission-prompt-tool mcp__event-horizon__permission_prompt` (the policy above applies).
- **`skip`** → `--dangerously-skip-permissions` (no gate; the legacy behavior).

Defaults come from the workspace **risk tolerance** setting (`config.permissions`: `boardDefault` default `gated`, `ticketDefault` default `skip` — see [configuration](../configuration.md)). The per-chat **Perms** picker (Default / Gated / Skip) overrides per turn; "Default" inherits the configured value. Delegated/headless sessions (combiner, relay) can't block on a human, so they run un-gated regardless.

**FLUX-926 (chat file-edit gate) — Claude Code only; see FLUX-1123 below for Copilot/Gemini.** Ticket **chat** (`phase: 'chat'`) defaults to **skip** mode, so `permission_prompt` never fires for it — a status check there would be dead code for the default path. Instead, chat may edit files **only while the ticket is `In Progress`**: `disallowedToolsArgs` (`agents/claude-code.ts`) additionally disallows `Write`/`Edit`/`MultiEdit`/`NotebookEdit` and the known Serena file-mutation MCP tools via `--disallowed-tools` whenever `session.phase === 'chat'` and the ticket's status is not `In Progress` — permission-mode-independent, so it holds under `gated` too. Chat turns re-spawn the CLI each turn with the live ticket status in scope, so moving the ticket to `In Progress` re-enables editing on the very next turn (no restart needed), and moving it back out disables it again. Dispatched `grooming`/`implementation`/`review`/`finalize` sessions and the board/orchestrator session are unaffected (they aren't phase `'chat'`, or have no ticket status). This is a denylist, not a sandbox: it doesn't cover `Bash` (read-only dev commands are useful in a grooming chat) or any future file-writing MCP tool by name.

**FLUX-1123 (gap: this gate does not exist for Copilot/Gemini chat).** Ticket chat's framework is not pinned to Claude — a workspace can configure Copilot or Gemini as its default chat agent (`AgentSection.tsx`'s `defaultAgent` setting), or a launch surface can pick one explicitly. Neither the Copilot nor the Gemini CLI exposes a `--disallowed-tools`-equivalent flag (confirmed against both live CLIs — see the comments atop `agents/copilot-board.ts` / `agents/gemini-board.ts`), so **there is no real enforcement for those frameworks**: `CLI_CAPABILITIES[framework].chatEditGateEnforced` (`agents/types.ts`) is `true` only for `claude`. Copilot/Gemini chat instead gets a best-effort **advisory note** in the prompt — `chatEditGateNote` (`agents/shared.ts`), wired into both the initial spawn (`buildInitialPrompt`'s `editsGated` option) and every resumed turn (`prependEditGateNote`) — asking the agent to treat file-mutation tools as off-limits on its own judgment. This is a request, not a block: a misbehaving or jailbroken agent on a Copilot/Gemini-default workspace can still edit files at any ticket status. Treat this as a known, accepted limitation of those adapters rather than parity with Claude.

---

### `ask_user_question`

Ask the user a **structured multiple-choice question** and block until they answer — the working substitute for the native `AskUserQuestion` tool, which can't be fulfilled in EH's `claude -p` print-mode spawns (no interactive TTY surface; see FLUX-662). The schema mirrors the native tool so agents reach for it the same way; chat and board prompts also steer the agent toward it ("never assume; ask"). Native `AskUserQuestion` is disabled in these spawns via `--disallowed-tools AskUserQuestion` so it can never be silently denied.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `questions` | array | yes | One or more questions (usually one). Each: `{ question, header, options[], multiSelect? }`. |
| `questions[].question` | string | yes | The full question text. |
| `questions[].header` | string | yes | A very short label/category. |
| `questions[].options` | array | yes | `{ label, description? }` choices (≥1). |
| `questions[].multiSelect` | boolean | no | Allow selecting multiple options (default false). |

**Behavior:** the handler POSTs to [`/api/board/ask-question`](rest-api.md) with the questions + the session's `EH_CONVERSATION_ID`, and **blocks on the held-open HTTP response** until the user answers in the portal (or a 4-minute timeout — held under undici's 300s `headersTimeout` so the long-poll fetch doesn't abort before the park resolves). The reuse of the FLUX-605 round-trip is exact; the only difference is the payload — chosen option label(s) + an optional note, not allow/deny. It emits the `ask-question` / `ask-question-resolved` realtime events ([realtime channels](realtime-channels.md)) so the portal can render the picker inline in the originating chat (or a global overlay when unrouted).

**Output:** `{ answers: { [questionText]: chosenLabel | chosenLabel[] }, notes? }` (JSON text). On timeout the agent receives a plain-text "the user did not answer in time — proceed with your best judgment" so a parked question never crashes the turn. **FLUX-826:** a timeout on a ticket-bound question (the `EH_CONVERSATION_ID` is a real ticket id) also raises a persistent **"Needs Action"** flag + notification on that ticket, so a missed question survives even when the user wasn't watching the live picker — this is what makes the structured route safe on a resting/terminal ticket where `Require Input` (status-coupled) doesn't fit.

---

## Furnace tools

The Furnace (FLUX-1008) is the overnight autonomous ticket runner — see the [Furnace reference](furnace.md) for the full data model, REST surface, and realtime events. A **batch** is a named bucket of tickets the Furnace burns unattended (implement → review → re-implement ≤ `retryCap` → leave the PR open at `Ready`); it **never merges**.

### `furnace_get`

Read Furnace batch(es). Pass `batchId` for one batch (its tickets + config + PRs + burn report); omit it to list every batch (optionally filter by `status`).

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `batchId` | string | no | A specific batch id; omit to list all batches. |
| `status` | enum | no | When listing, only batches in this status: `draft` \| `burning` \| `done` \| `parked`. |

**Output:** the batch object (with `batchId`) or, without `batchId`, `{ batches, slots: { used, free, max } }`.

### `furnace_build`

Build a Furnace batch from the groomed backlog and create it as a `draft` you can edit and then ignite. **A batch must always be an intentional selection (FLUX-1051): `tag` or `tickets` is required — neither given is refused, and there is no `allTickets` escape hatch to pool the whole backlog.** Deterministically reasons about independence (excludes parent/child pairs; flags — never blocks — likely file overlaps and orders them apart), enforces the one-active-batch invariant (a ticket already queued in another non-terminal batch is excluded, not double-loaded), and returns the created batch plus what it excluded and why — every tagged/named ticket lands in the batch or in `excluded` with a concrete reason, never silently dropped. Defaults to a `parallel` batch (each ticket its own worktree + PR); pass `kind: 'sequential'` for tickets that must stack onto one shared branch + PR in order.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `tag` | string | one of `tag`/`tickets` | Load tickets carrying this tag (the opt-in convention is `burn-furnace`). |
| `tickets` | string[] | one of `tag`/`tickets` | Explicit ticket ids to include — the other selector, usable instead of or alongside `tag`. Runs through the same curation as a tag scan (parent/child exclusion, overlap flag/order), not a raw pass-through. |
| `statuses` | string[] | no | Statuses that count as groomed & ready (default `["Todo"]`); a non-default override is echoed in `notes`. |
| `limit` | number | no | Cap the batch to at most this many tickets. |
| `kind` | enum | no | `sequential` \| `parallel` (default `parallel`). |
| `burnRate` | number | no | Parallel concurrency, 1–4 (default 1). Ignored for sequential. |
| `title` | string | no | Human label for the batch. |

**Output:** `{ batchId, batch, excluded, notes }` — the created `draft` batch plus the excluded tickets (with reasons: `tagged but status <X> (not allowed)`, `already queued in batch <id>`, `parent of loaded ticket <id> — ...`, `capped by limit`, `unknown ticket id`) and human-facing build notes (leading with a `⚠ N tagged ticket(s) NOT loaded` warning when a tag scan drops anything).

### `furnace_update`

Live-adjust a batch — title, burn rate, kind, retry cap, circuit breaker, rate-limit cooldown config, and auto-trigger. Changes are picked up on the next stoke tick. `kind`/`branch` are only changeable while the batch is a `draft`. Does **not** ignite or stop a batch — dedicated tools handle those.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `batchId` | string | yes | The batch to update. |
| `title` | string | no | Display name. Safe to change while burning (branch unchanged). |
| `kind` | enum | no | `sequential` \| `parallel`. Only changeable while draft. |
| `burnRate` | number | no | Parallel concurrency, 1–4 (clamped). Ignored for sequential. |
| `retryCap` | number | no | Re-implementation attempts before parking (default 2). |
| `maxConsecutiveFailures` | number | no | Circuit breaker: halt the batch after N consecutive parks/failures. |
| `rateLimitRetryIntervalMs` | number | no | How often (ms) a rate-limited ticket auto-retries (FLUX-1063; default 20m). |
| `rateLimitMaxWaitMs` | number | no | Max time (ms) a ticket may cool down before failing outright (FLUX-1063; default 5h). |
| `trigger` | object \| null | no | `{ type: 'batch' \| 'pr', ref }` — auto-ignite once the referenced batch/PR merges. `null` clears it. |

### `furnace_batch` (FLUX-1085 — batch lifecycle)

Transition an existing batch: `action` discriminates `ignite` / `stop` / `resume` / `discard`. These four share a near-identical `{ batchId, ... }` shape (only `stop` takes extra params), so FLUX-1085 folded them into one tool the same way `branch` folds `create`/`status`/`delete` — `furnace_get`/`furnace_build`/`furnace_update` stayed separate tools because their per-action param sets (read filters, build selectors, live-config knobs) are too heterogeneous to merge without hurting usability.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | enum | yes | `ignite` \| `stop` \| `resume` \| `discard`. |
| `batchId` | string | yes | The batch to transition. |
| `reason` | string | `stop` only | Why it is being stopped (recorded on the batch). Rejected with `validation_failed` on any other action. |
| `hard` | boolean | `stop` only | Immediate cutoff: kill in-flight sessions instead of letting them drain. Rejected with `validation_failed` on any other action. |

- **`ignite`** — move `draft`→`burning` and start burning its tickets. Claims a worktree slot — fails with `no_slots` when the pool is full (max 4 concurrent). A parallel batch clamps its burn rate to the free slots.
- **`stop`** — default is a **graceful** stop: stop feeding new tickets, let in-flight ones finish (open PRs stay open for review), then the batch finalizes. `hard: true` is an immediate cutoff that kills in-flight sessions, parks them, and skips the rest.
- **`resume`** (FLUX-1066) — a halted (`parked`) or finished (`done`) batch → `burning`: resets the circuit breaker, clears the stop request, re-queues tickets merely skipped by the halt, claims a worktree slot (`no_slots` if the pool is full). Parked/failed tickets are **not** auto-re-queued — retry those individually via `furnace_ticket action:"retry"`.
- **`discard`** (FLUX-1081) — permanently delete a batch. Refuses a `burning` batch (`invalid_state`) — stop it first. The cleanup path for a stale/superseded draft that a full `furnace_build` rebuild used to leave orphaned forever.

### `furnace_ticket` (FLUX-1085 — per-ticket ops)

Act on one ticket inside a batch: `action` discriminates `retry` / `dismiss` / `takeover` / `handback` / `add` / `remove` — the manual escape hatches for a parked/failed ticket or halted batch (same actions the Furnace drawer exposes), plus draft/membership curation. All six actions share the exact same `{ batchId, ticketId }` shape — the cleanest possible merge candidate (no per-action extra params at all).

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | enum | yes | `retry` \| `dismiss` \| `takeover` \| `handback` \| `add` \| `remove`. |
| `batchId` | string | yes | The batch containing the ticket. |
| `ticketId` | string | yes | The ticket to act on. |

- **`retry`** (FLUX-1066) — reset a parked/failed ticket to `queued` with a **fresh** attempt budget; hands ownership back to the Furnace. Re-burns next tick if the batch is burning; a halted/finished batch needs `furnace_batch action:"resume"` first. Rejects a `pr-open` ticket (already succeeded — use takeover/handback instead).
- **`dismiss`** (FLUX-1066) — clear the board `require-input` flag on a parked/failed ticket **without** re-queuing ("I've got this"). Works on a `done`/terminal batch too.
- **`takeover`** (FLUX-1066) — owner → human: the Furnace yields (stops the session it was driving, never reclaims the worktree). Hand it back later with `handback`.
- **`handback`** (FLUX-1070) — owner → furnace: re-queue a human-owned ticket with a fresh attempt budget, bypassing the pr-open/active-state guards (a human is deliberately returning it). Errors clearly if the ticket is not currently human-owned — unlike `retry`, which has no such guard.
- **`add`** (FLUX-1081) — append the ticket to a batch (draft or burning) — picked up by the Stoker on its next tick. Rejects a `done` batch, a ticket already in the batch, one that fails the same existence/status validation as `furnace_build` (default allowed status: `Todo`), or one already queued in a *different* non-terminal batch (FLUX-1051 one-active-batch invariant — the error names the owning batch).
- **`remove`** (FLUX-1081) — remove the ticket from a batch. Disallowed while it is actively burning in a `burning` batch (`invalid_state`) — a `queued` ticket or one in any terminal state can always be removed.

---

## FLUX-882 tool consolidation (migration)

The MCP surface was consolidated from **34 tools to 24** by folding single-op tools behind an `action`/`type` discriminator (and folding `create_subtask` into `create_ticket`). This was a **hard cut — the old tool names were removed, with no aliases.** An agent calling an old name gets an "unknown tool" error and must use the new name. The forced-reinstall path (orphan sweep + one-time bootstrap migration, see [agent-integrations](../agent-integrations.md)) cleans stale skill files so updated users converge on the new surface.

| Old tool(s) | New tool | How to call |
|-------------|----------|-------------|
| `delegate_to_agent`, `delegate_parallel` | `delegate` | `delegate({ ticketId, delegations: [{ personaId, task, effort?, model? }], timeout? })` — length-1 serial, >1 parallel; always returns a JSON array |
| `create_subtask` | `create_ticket` | `create_ticket({ title, parentId, … })` — `parentId` triggers the atomic subtask-link path |
| `create_branch` | `branch` | `branch({ ticketId, action: 'create', baseBranch?, worktree? })` |
| `get_branch` | `branch` | `branch({ ticketId, action: 'status' })` |
| `delete_branch` | `branch` | `branch({ ticketId, action: 'delete', force? })` |
| `list_group_docs` | `group_doc` | `group_doc({ action: 'list' })` |
| `read_group_doc` | `group_doc` | `group_doc({ action: 'read', path })` |
| `submit_group_doc` | `group_doc` | `group_doc({ action: 'submit', path, title, body, message? })` |
| `delete_group_doc` | `group_doc` | `group_doc({ action: 'delete', path })` |
| `set_swimlane` | `swimlane` | `swimlane({ ticketId, action: 'set', swimlane, comment? })` |
| `clear_swimlane` | `swimlane` | `swimlane({ ticketId, action: 'clear', comment? })` |
| `add_comment` | `add_note` | `add_note({ ticketId, type: 'comment', message, user?, summary?, pin?, supersedes? })` |
| `log_progress` | `add_note` | `add_note({ ticketId, type: 'activity', message, summary?, pin?, supersedes? })` |
| `archive_ticket` | `archive` | `archive({ ticketId, action: 'archive', comment? })` |
| `unarchive_ticket` | `archive` | `archive({ ticketId, action: 'unarchive', toStatus? })` |

**Kept separate (NOT merged):** `update_ticket` (metadata only — never moves status) and `change_status` (the state machine — the only tool that moves status). Their descriptions were retightened so the distinction is unmistakable.

**Permission gating** stayed equivalent through the rename and is now **action-aware**: `branch` is confirm-gated only on `action: 'delete'`; `archive` is confirm in both directions; `change_status` / `extract_ticket` / `merge_tickets` / `finish_ticket` remain confirm; `add_note` / `delegate` / `group_doc` / `swimlane` / `create_ticket` are auto-allow. `furnace_batch` (FLUX-1085) is likewise action-aware — confirm-gated only on `action: 'discard'` (a genuine hard delete: unlinks the batch's sidecar file, no undo, unlike `archive`'s reversible status move); `ignite`/`stop`/`resume` are auto-allow. `furnace_ticket` (FLUX-1085) is auto-allow across all six of its actions, since none of them are destructive. See [`permission_prompt`](#permission_prompt).

> `swimlane` (set/clear) was not previously documented as its own section here; it lives in [`mcp-server.ts`](../../../engine/src/mcp-server.ts) `buildMcpServer()` like the rest. The `'require-input'` swimlane keeps its special-cased session-parking behavior under `swimlane({ action: 'set', swimlane: 'require-input', comment })`, mirroring `change_status` → Require Input.

---

## FLUX-1085 Furnace tool consolidation (migration)

The Furnace MCP surface grew to 13 single-op tools as recovery (FLUX-1066/1070) and draft-curation (FLUX-1081) tools were added on top of the original five. FLUX-1085 investigated folding the whole family into one `furnace(action, ...)` tool (mirroring the FLUX-882 precedent above) and found that too aggressive: the read/build/config tools (`furnace_get`/`furnace_build`/`furnace_update`) have large, heterogeneous per-action param sets (read filters vs. build selectors vs. live-config knobs) that would produce one bloated schema harder for a model to use correctly than 3 tight ones — exactly the risk the investigation ticket called out. Instead it did a **partial, shape-driven consolidation**: only tools sharing a near-identical signature were merged, same-branch-precedent as `branch`'s `force`-only-on-delete guard.

This was also a **hard cut — the old tool names were removed, with no aliases** (consistent with the FLUX-882 precedent).

| Old tool(s) | New tool | How to call |
|-------------|----------|-------------|
| `furnace_ignite` | `furnace_batch` | `furnace_batch({ action: 'ignite', batchId })` |
| `furnace_stop` | `furnace_batch` | `furnace_batch({ action: 'stop', batchId, reason?, hard? })` |
| `furnace_resume` | `furnace_batch` | `furnace_batch({ action: 'resume', batchId })` |
| `furnace_discard` | `furnace_batch` | `furnace_batch({ action: 'discard', batchId })` |
| `furnace_retry` | `furnace_ticket` | `furnace_ticket({ action: 'retry', batchId, ticketId })` |
| `furnace_dismiss` | `furnace_ticket` | `furnace_ticket({ action: 'dismiss', batchId, ticketId })` |
| `furnace_takeover` | `furnace_ticket` | `furnace_ticket({ action: 'takeover', batchId, ticketId })` |
| `furnace_handback` | `furnace_ticket` | `furnace_ticket({ action: 'handback', batchId, ticketId })` |
| `furnace_add_ticket` | `furnace_ticket` | `furnace_ticket({ action: 'add', batchId, ticketId })` |
| `furnace_remove_ticket` | `furnace_ticket` | `furnace_ticket({ action: 'remove', batchId, ticketId })` |

**Kept separate (NOT merged):** `furnace_get` (read), `furnace_build` (create), `furnace_update` (live-config) — each keeps its own large, distinct param set. Net effect: 13 Furnace tools → 5 (a 62% cut, deeper than FLUX-882's 29% because every merged group here has a genuinely uniform signature).

---

## Error model

All tools that detect a problem return `{ isError: true, content: [{ type: 'text', text: '<message>' }] }`. The MCP SDK surfaces this as a tool error in the calling agent. Common shapes:

| Message | Cause |
|---------|-------|
| `Ticket <id> not found` | unknown ticket |
| `Workspace is activating, please retry` | engine is still loading `.flux/` on startup or workspace switch |
| `Schema validation failed:\n<details>` | frontmatter would be invalid — see `schema.ts` |
| `Transitioning to <status> requires a comment …` | enforcement on `Require Input` / `Ready` |
| `Failed to <op>: <git error>` | git wrapper surfaced an underlying error |

## Cross-references

- [Architecture: MCP Server](../mcp-server.md) — high-level overview, how the MCP transport plugs in.
- [Reference: REST API](rest-api.md) — the portal-facing surface that shares the same state.
- [Code Map](../architecture/code-map.md) — where each subsystem lives.
- [Ticket Lifecycle](../workflow/ticket-lifecycle.md) — when to call which tool during a ticket.
