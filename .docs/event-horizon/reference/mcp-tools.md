---
title: MCP Tools Reference
order: 1
---
# MCP Tools Reference

Authoritative list of every tool exposed by the Event Horizon MCP server ([`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts)). Each entry lists the input schema, output shape, side effects, and enforcement rules.

> Agents should prefer MCP tools over the REST API. The portal uses REST; agents use MCP. Both share the same in-memory state and validation.

## How tools are exposed

The tool set is built once by `buildMcpServer()` ([`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts)) and served over **two transports**, both via `@modelcontextprotocol/sdk`:

### Streamable-HTTP, in-process on the engine (default, FLUX-645)

The already-running portal engine mounts the MCP server in-process and exposes it over loopback HTTP at `POST/GET/DELETE http://127.0.0.1:<engine-port>/mcp` (`handleMcpHttpRequest`, wired in [`engine/src/index.ts`](../../../engine/src/index.ts)). Every Claude Code session — whether opened in the main checkout or in a `.eh-worktrees/*` git worktree — points at this one URL and shares the engine's **single** task-store cache and chokidar watchers. There is **no per-session stdio process** and no per-request `--workspace`; the server binds to the engine's already-active canonical workspace.

The installer renders the location-independent HTTP entry into `.mcp.json` with the configured port, re-writing it on every engine start so a port change is picked up:

```json
"event-horizon": { "type": "http", "url": "http://127.0.0.1:3067/mcp", "alwaysLoad": true }
```

Key properties:

- **Per-session isolation.** Each session gets its own `StreamableHTTPServerTransport`, keyed by the `Mcp-Session-Id` header the transport assigns on `initialize`; transports are removed on close. Concurrent sessions never cross-talk.
- **Raw stream, not pre-parsed.** The `/mcp` routes are registered **before** `express.json()` so the JSON-RPC request stream reaches the transport unparsed — `express.json()` would otherwise consume the body and the transport would hang.
- **Per-ticket write serialization.** With one shared server, concurrent sessions can issue concurrent read-modify-write on the same ticket's history. `updateTaskWithHistory` ([`engine/src/task-store.ts`](../../../engine/src/task-store.ts)) serializes writes per `ticketId` (a promise chain) so near-simultaneous `add_comment`/`log_progress`/`change_status` calls on one ticket no longer drop history entries; writes to *different* tickets stay parallel.
- **Engine-restart reconnect caveat.** The MCP connection is bound to the engine process, so restarting the engine (e.g. the tsx-watch dev loop restarting on a code edit, or a customer update/crash) drops the connection. Claude Code reconnects on its next call; mid-call work in flight at the moment of restart is lost. This is the accepted residual for the single-process design.

### Stdio (headless `--mcp` fallback)

`startMcpServer()` keeps the original stdio behaviour for the headless entry point (`engine/src/index.ts --mcp --workspace /path/to/project`). It calls the same `buildMcpServer()` then connects a `StdioServerTransport`. Logs go to stderr so they never corrupt protocol framing on stdout. The worktree-redirect machinery (`EH_CANONICAL_WORKSPACE` / `resolveMainWorktree`) that lets a stdio server in a worktree bind to the canonical store is retained for this path (its broader fate is tracked in FLUX-646).

## Tool index

| Tool | Category | Mutates? |
|------|----------|----------|
| [`get_ticket`](#get_ticket) | Read | — |
| [`get_session_log`](#get_session_log) | Read | — |
| [`list_tickets`](#list_tickets) | Read | — |
| [`get_board_config`](#get_board_config) | Read | — |
| [`get_board_state`](#get_board_state) | Read | — |
| [`propose_board_rebase`](#propose_board_rebase) | Orchestrator (propose) | — |
| [`get_project_group`](#get_project_group) | Read | — |
| [`list_group_docs`](#list_group_docs) | Group docs — Read | — |
| [`read_group_doc`](#read_group_doc) | Group docs — Read | — |
| [`submit_group_doc`](#submit_group_doc) | Group docs — Write | yes |
| [`delete_group_doc`](#delete_group_doc) | Group docs — Write | yes |
| [`extract_ticket`](#extract_ticket) | Mutation (gated) | yes (CONFIRM) |
| [`merge_tickets`](#merge_tickets) | Mutation (gated) | yes (CONFIRM) |
| [`update_ticket`](#update_ticket) | Mutation | yes |
| [`change_status`](#change_status) | Mutation | yes (enforced) |
| [`archive_ticket`](#archive_ticket) | Mutation | yes |
| [`unarchive_ticket`](#unarchive_ticket) | Mutation | yes |
| [`add_comment`](#add_comment) | Mutation | yes |
| [`log_progress`](#log_progress) | Mutation | yes |
| [`finish_ticket`](#finish_ticket) | Lifecycle (atomic) | yes |
| [`create_subtask`](#create_subtask) | Mutation | yes |
| [`create_branch`](#create_branch) | Branch | yes |
| [`get_branch`](#get_branch) | Branch | — |
| [`delete_branch`](#delete_branch) | Branch | yes |
| [`permission_prompt`](#permission_prompt) | Internal (gating) | — |
| [`ask_user_question`](#ask_user_question) | Interaction (blocking) | — |

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

**Output:** JSON — full frontmatter + `body` + digested `history`. The internal `_path` field is stripped. Digest rules (`serializeTaskForAgent` in [`task-store.ts`](../../../engine/src/task-store.ts), `digestHistoryForAgent` in [`history.ts`](../../../engine/src/history.ts)):

- `agent_session` entries lose their `progress[]` array and gain a `progressCount` instead — fetch the raw log via [`get_session_log`](#get_session_log) when needed. All other fields (`sessionId`, `status`, `outcome`, `startedAt`, `endedAt`, …) are preserved.
- `status_change` entries are dropped from the digest (the current status is already in the frontmatter); `comment` and `activity` entries pass through.
- **Summary-gated collapse:** older `comment`/`activity` entries that carry an agent-written `summary` **and an `id`** are returned collapsed — `{ type, user, date, summary, id, collapsed: true }` instead of the full body. Kept full: the last `commentDigest.keepRecent` (config, default 3) entries, any `pin: true` entry, any entry without a summary (never force-truncated), and any entry without an `id` (couldn't be recovered). `collapsedCount` reports how many were collapsed; fetch a collapsed entry's full text with `expand: ["<id>"]` (or `fullHistory: true`).
- Older `agent_session` entries are likewise collapsed to their `outcome` (shown as `summary`), keeping `sessionId` — recover the full session via [`get_session_log`](#get_session_log)`(ticketId, sessionId)`, **not** `expand` (collapsed sessions carry `sessionId`, not `id`).
- **Temporal supersession collapse** (FLUX-811): a `comment`/`activity` entry explicitly superseded by a **later** entry (via that entry's `supersedes: ["<id>"]`) collapses to `{ type, user, date, supersededBy: "<superseder-id>", summary?, id, collapsed: true }` — **independent of the recent-window** (it collapses even when recent, because a dead decision is noise regardless of age), recoverable via `expand: ["<id>"]`. **Guardrail:** an *agent*-authored supersession never collapses a `pin: true` or user-authored target; that target stays full and instead gains an advisory `supersededByAdvisory: "<superseder-id>"` flag. See [ticket-schema → supersedes](ticket-schema.md#per-type-fields).
- Only the most recent `historyLimit` entries are returned; when older ones are omitted, the response includes `olderHistoryEntries: <count>`.
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

List or filter tickets.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | string | no | Filter by status name |
| `assignee` | string | no | Filter by assignee |
| `tag` | string | no | Ticket must include this tag |
| `priority` | string | no | One of: `Critical`, `High`, `Medium`, `Low`, `None` |

**Output:** JSON array of summaries `{ id, title, status, priority, effort, assignee, tags }`. Bodies and history are not included — use `get_ticket` for full content.

### `get_board_config`

Read board configuration.

**Input:** none.

**Output:** `{ statuses, projects, tags, priorities, users, requireInputStatus, readyForMergeStatus }`. `statuses` merges visible columns and hidden statuses.

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

**Teeth:** the mutating verbs `change_status`, `archive_ticket`, `extract_ticket`, and `merge_tickets` are in the [`permission_prompt`](#permission_prompt) **Confirm** tier, so a *direct* orchestrator call to mutate is gated even if it bypasses this ritual — "never silently restructure" is enforced by the gate, not just the prompt.

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

### `list_group_docs`

List the shared group docs (the cross-project knowledge base) by path and title. Works from any workspace — **parent or bound member** — because both resolve the store via `activeGroupStoreDir()` ([`task-store.ts`](../../../engine/src/task-store.ts)).

**Input:** none.

**Output (docs present):**
```jsonc
{ "docs": [{ "path": "Product/features/payments-api", "title": "Payments API", "directory": "Product/features" }], "label": "Product" }
```

**Output (empty store):** `{ "docs": [], "message": "No group docs found — the shared store may be empty." }`

**Output (no group):** `{ "docs": [], "message": "No group configured …" }` — not an error; single-repo returns this.

### `read_group_doc`

Read the full body of a shared group doc.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | As returned by `list_group_docs`, e.g. `"Product/features/payments-api"` |

**Output:** `{ path, title, body, directory }`.

**Errors:** `Group doc '<path>' not found. Use list_group_docs to see available paths.`

### `submit_group_doc`

Create or update a shared group doc. Commits on `flux-group-docs` in the parent's canonical store and fans out to all members. Works from any workspace — **parent or bound member**.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | Store-relative path **without** the group prefix and **without** `.md`: e.g. `"features/payments-api"`, `"architecture/overview"`. No `..`, no absolute paths. |
| `title` | string | yes | Document title (prepended as H1). |
| `body` | string | yes | Full markdown body (title heading not included). |
| `message` | string | no | Git commit message. Auto-generated when omitted. |

**Output:** `{ applied, committed, pushed, failed, members: [{ name, ok, diverged?, error? }] }`. The `members` array reports per-member fan-out outcomes so the agent knows which repos received the change.

**Errors:** `No group writer is available …` when the workspace is neither a parent nor a bound member.

### `delete_group_doc`

Delete a shared group doc. Commits the deletion on `flux-group-docs` and fans out.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | Full doc path including the group prefix, as returned by `list_group_docs` (e.g. `"Product/features/payments-api"`). |

**Output:** `{ deleted, committed, pushed, failed, members }`.

**Errors:** `'<path>' is not a valid group doc path …` when the path doesn't start with the group prefix.

---

## Mutation tools

All mutation tools:

- Validate frontmatter against [`schema.ts`](../../../engine/src/schema.ts) before writing.
- Set `updatedBy` to `'Agent'` (or the provided `user`/`author`).
- Auto-register any new tags into board config (`autoRegisterUnknownTags`).
- Broadcast an SSE `taskUpdated` or `taskCreated` event so the portal reacts live.

### `create_ticket`

Create a new ticket.

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `title` | string | yes | — |
| `status` | string | no | `Todo` |
| `priority` | string | no | `None` |
| `effort` | string | no | `None` |
| `assignee` | string | no | `unassigned` |
| `tags` | string[] | no | `[]` |
| `body` | string | no | `''` |
| `author` | string | no | `Agent` |

**Output:** `{ id, title, status }`. When `body` exceeds 10,000 chars the output also carries a `warning` field — the write is accepted, but the agent is nudged to keep bodies a concise plan and move bulk material to `.docs/`.

**Side effects:** assigns the next `<projectKey>-N` id, writes `.flux/<id>.md`, seeds a creation activity entry in history.

**Errors:** `Workspace is activating, please retry`; `Schema validation failed: …`.

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

**Output:** `{ id, title, turnsExtracted }`.

**Side effects:** creates the new ticket (`create_ticket` path) and appends one `extract` op to
the curation op-log (`<fluxDir>/transcripts/_curation-ops.jsonl`). The source turns are **never
moved or copied** — the new card's transcript re-derives the slice from substrate + op-log, so
extract is additive and un-doable (remove the op → the view reverts).

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

**Output:** `Updated <id>`. When a provided `body` exceeds 10,000 chars, a soft warning is appended to the output (the write still succeeds).

**Side effects:** appends a single `activity` history entry summarizing the field changes (e.g. *"Updated title. Changed priority to High."*).

### `change_status`

Move a ticket to a new status.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `newStatus` | string | yes |
| `comment` | string | conditional — see enforcement |
| `callerRole` | string | no — set to `"orchestrator"` or `"lead"` to bypass scatter-gather restriction |
| `reviewState` | `'approved'` \| `'changes-requested'` \| null | no — **FLUX-816.** Records the EH review verdict on the card (persisted as the [`reviewState`](ticket-schema.md) frontmatter field). A review lead passes `"approved"` when moving to `Ready` and `"changes-requested"` when moving back to `In Progress`; `null` clears it. Surfaces a review badge; distinct from the GitHub-synced `reviewDecision`. |

**Enforcement:**

- Transitioning **to** `Require Input` requires `comment` (the question to ask the user).
- Transitioning **to** `Ready` requires `comment` (the completion summary), unless `config.requireCommentOnStatusChange === false`.
- **Commit-before-Ready for worktree branches (FLUX-730).** Transitioning **to** `Ready` is **refused** (error result, status unchanged) when the ticket's branch has a dedicated worktree **and** the branch has **0 commits ahead** of the default branch — an uncommitted worktree can never open a PR, so the move would land a silent "Ready, no PR". The error distinguishes "work done but uncommitted" (worktree has changes) from "no changes yet" and tells the agent to commit then retry. **Scoped to worktree branches only:** plain-branch tickets keep the soft warning (notification + activity, move still proceeds), and branchless tickets are unaffected (they legitimately stay uncommitted until `finish`). On a successful `Ready` move for a branch with commits, the engine pushes and opens the PR (`implementationLink` + `open-pr` swimlane).
- **Dirty-root backstop for engine-driven switches (FLUX-741).** Sibling to the commit-before-Ready discipline, but for the **main/root checkout** rather than worktrees. Whenever the engine *must* switch or fast-forward the root tree off a branch during post-merge cleanup (`cleanupMergedBranch`'s `git checkout <default>` and `syncDefaultBranch`'s in-place `merge --ff-only`), it first **stashes any uncommitted/untracked root work** (`stashDirtyTree`, reusing the detach stash pattern) so the switch can never silently discard it — the root-clobber that lost work in the FLUX-734/739 incidents. The stashed work stays recoverable (`git stash apply <ref>`) and the ref is surfaced in a notification. Worktree mutation points are already guarded (`removeTaskWorktree` refuses a dirty tree; `detachTaskWorktree` stashes); this closes the gap on the root tree only. The complementary fix is **worktree-by-default** (see `create_branch`): isolating agent sessions in their own worktree means the shared root is rarely the place edits live in the first place.
- The `Require Input` / `Ready` status names are read from `configCache.requireInputStatus` / `readyForMergeStatus` and may be renamed in board config.
- **Scatter-gather guard:** If the ticket has 2+ active sessions where at least one has `patternPosition: 'step'`, status changes are rejected unless `callerRole` is `'orchestrator'` or `'lead'`. This prevents individual reviewers from moving the ticket while peers are still reviewing. Affected sessions should use `add_comment` instead.

**Output:** `<id> moved to <status>`.

**Side effects:** appends a `comment` entry when one is provided, plus a `status_change` entry recording the transition.

- **Stale parked-session reaping (FLUX-721).** On a genuine **forward** transition (any `newStatus` other than `Require Input`, where parking is legitimate), the ticket's sessions still parked at `waiting-input` on an **earlier phase** are terminalized (`reapStaleParkedSessions`). This prevents grooming/implementation sessions left parked after the ticket advances from lingering as zombies that gate merges (the [`POST /:id/pr/merge`](rest-api.md) Tier-2 guard) or 409 new session starts. The live calling agent (`running`) and the persistent per-ticket **`chat`** session (`phase: 'chat'`) are preserved. An `activity` entry records any reap.

### `archive_ticket`

Safely remove a ticket from the active board by moving it to the **Archived** status (`config.archiveStatus`, default `Archived`). This is the reversible alternative to deletion: history is preserved and the ticket can be restored with [`unarchive_ticket`](#unarchive_ticket). **There is no hard-delete MCP tool** — prefer archiving.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | |
| `comment` | string | no | Reason for archiving (recorded as a `comment` entry) |

**Behavior:** no-op-safe — returns `<id> is already <Archived>` if the ticket is already archived. Clears any active swimlane (and dismisses its notifications) so the archived ticket doesn't carry a stale blocked flag. Reaps stale parked **phase** sessions (`waiting-input`, non-`chat`) so an archived ticket leaves no session zombies behind (FLUX-721).

**Output:** `<id> archived (moved to <Archived>)`.

### `unarchive_ticket`

Bring an archived ticket back onto the active board by moving it out of the Archived status.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | |
| `toStatus` | string | no | Status to restore to (default `Todo`); must not be the archive status |

**Errors:** `<id> is not archived (status is <status>).` if the ticket isn't currently archived.

**Output:** `<id> unarchived (moved to <toStatus>)`.

### `add_comment`

Append a comment to history.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `comment` | string | yes |
| `user` | string | no — defaults to `Agent` |
| `summary` | string | no — a faithful one-paragraph summary; shown in the agent digest once the comment ages past the recent window (full text via `get_ticket` `expand`). Provide for substantial comments; keep it concise but lossless. |
| `pin` | boolean | no — never collapse this comment in the agent digest (review handoffs / key decisions). |
| `supersedes` | string[] | no — ids of earlier history entries this comment makes obsolete (a decision reversed/replaced). The superseded entries collapse to a one-line marker in the agent digest (still recoverable via `expand`). A `pin: true`/user-authored target is advisory-only (kept full). Set ONLY when genuinely retiring a now-wrong entry. |

**Output:** `Comment added to <id>`.

### `log_progress`

Append an `activity` entry (different from a comment — used for "agent did X" updates).

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `message` | string | yes |
| `summary` | string | no — faithful summary shown in the agent digest once this note ages past the recent window (full text via `get_ticket` `expand`). |
| `pin` | boolean | no — never collapse this note in the agent digest. |
| `supersedes` | string[] | no — ids of earlier history entries this note makes obsolete. The superseded entries collapse to a one-line marker in the agent digest (recoverable via `expand`); a `pin: true`/user-authored target is advisory-only (kept full). |

**Output:** `Progress logged on <id>`.

---

## Lifecycle tool

### `finish_ticket`

Atomic close-out: set `implementationLink`, append a completion comment, move status to `Done`. For a **branch ticket** (with `gh` authenticated) it **merges the branch's PR** (squash) and then runs the shared post-merge cleanup (advance + master fast-forward + worktree/branch teardown, FLUX-574). The PR is normally opened at the Ready transition; if none exists at finish, finish **opens it first** (FLUX-578). Critically, if the branch's prior PR is already **MERGED or CLOSED** (a dead PR — e.g. a commit pushed *after* that PR merged, FLUX-656), finish does **not** merge onto the dead PR (which would throw "already merged" and strand the commit) — it opens a **fresh** PR and merges that instead (FLUX-741, `planFinishPr`). Only when the branch has **no commits ahead** of its base (nothing to merge) does it route the ticket to **Require Input** rather than failing on a raw merge error.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `implementationLink` | string | yes — commit hash or PR URL |
| `completionComment` | string | yes — summary of what was implemented |
| `force` | boolean | no — override the shared-PR guard (see below) |

**Output:** `<id> finished → Done (link: <url>)`.

**Side effects:**

- For a branch ticket: ensures an **OPEN** PR exists (opens a fresh one if missing **or if the existing PR is MERGED/CLOSED** — FLUX-741), squash-merges it, then runs the unified post-merge cleanup (`cleanupMergedBranch` — advance branch tickets, fast-forward master, remove worktree + delete branch, clear the `open-pr` swimlane). The post-merge cleanup stashes any **uncommitted work on the main/root checkout** before switching/fast-forwarding it, so an engine-driven branch switch can never silently discard root edits (FLUX-741, incident FLUX-734) — the work is surfaced as a recoverable stash via a notification.
- **Shared-PR guard (FLUX-569):** finishing one member of a branch shared by **non-terminal sibling tickets** is refused — merging would advance them all to Done as a one-way door (the FLUX-556/PR#6 incident). The error names the siblings; either finish/close them first, merge via the PR ticket, or re-run with `force: true` to land the whole shared PR. **PR tickets (`kind:'pr'`) are exempt** — merging a PR ticket to advance its members is the sanctioned shared-merge surface.
- Merge failure / `gh` unavailable → bounces the ticket back to In Progress with an actionable comment (no partial Done). A branch with **no commits ahead** of its base routes to **Require Input** (FLUX-741) — there is genuinely nothing to merge, so it surfaces as a blocker rather than looping.
- Writes status + link + comment in one disk write — no partial state on failure.
- Reaps stale parked **phase** sessions (`waiting-input`, non-`chat`) once the ticket is Done, so a finished ticket leaves no session zombies behind (FLUX-721).

---

## Branch tools

These wrap git operations through [`branch-manager.ts`](../../../engine/src/branch-manager.ts). Branches are named `flux/<lowercased-ticket-id>-<slug>`.

### `create_branch`

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `ticketId` | string | yes | — |
| `baseBranch` | string | no | `master` |
| `worktree` | boolean | no | **`true`** (agent sessions are worktree-isolated by default, FLUX-741) |

**Output:** `{ branch: "<name>", worktree?: "<path>", worktreeError?: "<msg>" }`.

**Worktree-by-default (FLUX-741).** This tool is the **agent** branch-creation path, so it **defaults `worktree` to `true`** — every agent branch session lands in its own dedicated git worktree at `<repoParent>/.eh-worktrees/<repo>-<id>` and runs isolated there (FLUX-516), so two parallel ticket sessions never share one checkout (the FLUX-734/739 root-clobber class of bug). The escape for **single-checkout / human-manual** branch work is to pass **`worktree: false`** explicitly — the agent then runs in the shared main tree. (The portal/human "Start task" path — `POST /:id/branch` — is *separate* and keeps its own default off, governed by the workspace `worktreeByDefault` setting; this default flip is agent-only.) The branch is always created first, so a worktree failure (e.g. hitting the concurrency cap of 4) is reported in `worktreeError` without failing the call. See [`task-worktree.ts`](../../../engine/src/task-worktree.ts).

**Errors:** ticket not found; `Ticket <id> already has branch: <name>`; git failure.

### `get_branch`

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |

**Output:** `{ name, exists, aheadCount, behindCount }`. If the ticket has no branch, returns `{ name: null, exists: false, aheadCount: 0, behindCount: 0 }`.

### `delete_branch`

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `ticketId` | string | yes | — |
| `force` | boolean | no | `false` |

**Output:** `Branch <name> deleted`.

**Enforcement:** refuses to delete unmerged branches unless `force === true`. If the ticket has a dedicated worktree, the session is stopped and the worktree detached first (a branch can't be deleted while a worktree holds it checked out). As an **abandon**, any uncommitted work is preserved as a recoverable stash ref but NOT applied onto master.

**Idempotent:** if the git branch is already gone (e.g. it was deleted by post-merge cleanup), the local delete is skipped rather than erroring, and the tool still clears the ticket's stale `branch` field. This makes it the way to detach a dead branch from a reopened ticket (FLUX-588).

> **Worktree teardown on finish:** `finish_ticket` stops the session and tears the ticket's worktree down (via detach) after the work is committed and the PR merged (FLUX-521). If the worktree still has **uncommitted** changes — e.g. someone was editing it by accident — they are surfaced onto master and noted on the ticket, never discarded. The manual `POST /:id/worktree/detach` escape hatch behaves the same.

---

## Subtask tool

### `create_subtask`

Create a child ticket and link it from the parent's `subtasks` array atomically.

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `parentId` | string | yes | — |
| `title` | string | yes | — |
| `status`, `priority`, `effort`, `assignee`, `body` | string | no | as `create_ticket` |
| `tags` | string[] | no | `[]` |

**Output:** `{ id, parentId, title, status }`.

**Side effects:**

- Allocates a new id from the same project key as the parent.
- Writes the child file with a creation activity entry referencing the parent.
- Rewrites the parent file to append the new id to its `subtasks` array.
- Broadcasts `taskCreated` with the `parentId` for portal hierarchy cues.

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
- **Confirm** — destructive ops `change_status`, `delete_branch`, `finish_ticket`, `Bash`, and the restructuring verbs `archive_ticket` / `extract_ticket` / `merge_tickets` (FLUX-659 teeth) route through a human Allow/Deny round-trip: the tool POSTs to [`/api/board/permission-request`](rest-api.md), which parks the call until a human resolves it in the portal (or 120s elapses → auto-deny). The synchronous CLI contract is satisfied by holding the HTTP response open until resolution.

The confirm round-trip emits the `permission-request` / `permission-resolved` realtime events ([realtime channels](realtime-channels.md)) so the portal can show the approval prompt. Gating is per-session: see [permission mode](#permission-mode) below.

**FLUX-833 (durable record + safety net).** For a ticket-bound request (the session's `EH_CONVERSATION_ID` is a real ticket id) the round-trip is also recorded durably: `permission-prompts.ts` appends a `permission-request` transcript event when approval is raised and a `permission-resolved` event when it settles, so a cold resume shows the approval in chat history (rendered as a quiet 🛡 `permission` note — see [substrate-vs-projection §4.4](../architecture/substrate-vs-projection.md)). On **timeout** the auto-deny also raises a persistent **"Needs Action"** flag + notification on the ticket (`raiseNeedsAction`, the same net `ask_user_question` uses, FLUX-826) — so a denied-by-timeout approval no longer silently vanishes. (Durability across an **engine restart** and re-injecting a late decision are later FLUX-833 phases; today the pending entry is still in-memory.)

#### Permission mode

Sessions are spawned in one of two modes (`permissionArgs` in [`agents/claude-code.ts`](../../../engine/src/agents/claude-code.ts)):

- **`gated`** → `--permission-prompt-tool mcp__event-horizon__permission_prompt` (the policy above applies).
- **`skip`** → `--dangerously-skip-permissions` (no gate; the legacy behavior).

Defaults come from the workspace **risk tolerance** setting (`config.permissions`: `boardDefault` default `gated`, `ticketDefault` default `skip` — see [configuration](../configuration.md)). The per-chat **Perms** picker (Default / Gated / Skip) overrides per turn; "Default" inherits the configured value. Delegated/headless sessions (combiner, relay) can't block on a human, so they run un-gated regardless.

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
