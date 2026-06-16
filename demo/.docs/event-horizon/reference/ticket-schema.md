---
title: Ticket Schema Reference
order: 3
---
# Ticket Schema Reference

Authoritative description of the ticket file format. Source of truth: [`engine/src/schema.ts`](../../../engine/src/schema.ts) and [`engine/src/history.ts`](../../../engine/src/history.ts).

> Every mutation tool (MCP) and REST endpoint validates frontmatter through `validateTicketFrontmatter` before writing. Invalid writes are rejected with a `SCHEMA_VALIDATION_FAILED` error and never reach disk.

## File layout

Each ticket is a single markdown file at `.flux/<ID>.md` (in-repo mode) or `.flux-store/<ID>.md` (orphan mode). File name = `<projectKey>-<n>.md` (e.g. `FLUX-42.md`). The file is YAML frontmatter followed by a markdown body:

```markdown
---
id: FLUX-42
title: Example ticket
status: Todo
priority: High
effort: M
assignee: unassigned
tags: [feature, engine]
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T10:00:00.000Z'
    comment: 'Ticket created.'
---

Markdown body. Free-form. May contain image links to `.flux/assets/FLUX-42/<name>`.
```

## Frontmatter fields

### Required

| Field | Type | Notes |
|-------|------|-------|
| `title` | string (non-empty) | Validated. |

### Required-by-convention (not enforced by schema, but always present in practice)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Set by the engine on create. Format `<PROJECT>-<n>`. Never change. |
| `status` | string | Must match a column or hidden status name in `config.json`. Schema only checks "non-empty string" — board config defines the allowed set. |
| `priority` | string | One of the names in `config.priorities`. Default `None`. |
| `effort` | string | `XS`, `S`, `M`, `L`, `XL`, or `None`. |
| `assignee` | string | A name in `config.users`, or `unassigned`. |
| `tags` | string[] | New tags are auto-registered in board config on save. |
| `createdBy` / `updatedBy` | string | Stamped by the engine. |
| `history` | HistoryEntry[] | See below. |

### Optional

| Field | Type | Notes |
|-------|------|-------|
| `subtasks` | string[] \| `{id: string}[]` | Child ticket ids. Object form is tolerated but objects without `id` are silently dropped on load (validation surfaces a warning). |
| `implementationLink` | string | Commit hash or PR URL. Set by `finish_ticket`. |
| `branch` | string \| null | Git branch name when one has been created for the ticket. |
| `baselineCommit` | string | HEAD sha captured at first session launch (Start Task). Used as the diff anchor for branch-less tickets. Note: generic diffs are reliable only for sequential work on a shared branch; concurrent work on a shared branch will include commits from other tickets in its diff range. |
| `diffSummary` | `{file, additions, deletions}[]` | Per-file change counts captured at `finish_ticket`. The matching full unified diff is written to `<flux-dir>/<ID>.diff` as a sidecar (2 MB hard cap). |
| `order` | number | Per-status manual sort position (set by drag and drop). |
| `cliSession` | object | **Not persisted** — serialized into API responses from the in-memory session store. Holds the most recent session summary for the ticket. Do not write this to the file. |
| `cliSessions` | object[] | **Not persisted** — full list of session summaries for the ticket, serialized from the session store. Present when the ticket has any sessions; the portal uses it to group sessions launched together (shared `groupId`) into one orchestration run. Each summary may carry `groupId`, `groupSeq`, `groupTotal`, `groupType` (`relay` \| `scatter-gather` \| `supervisor`), and `groupVariant` (`combiner` \| `headless`). `groupTotal` is the expected session count in the group, letting the UI render placeholder slots before all sessions have spawned. |
| `tokenMetadata` | object | Aggregated token counters surfaced to the UI. |

### Validation rules

From `validateTicketFrontmatter`:

- Frontmatter must be an object.
- `title` must be a non-empty string.
- `status`, if present, must be a non-empty string.
- `tags`, if present, must be an array of strings.
- `history`, if present, must be an array; each entry is validated individually.
- `subtasks`, if present, must be an array of strings or `{id}` objects.

## History entries

`history` is an append-only array. Every entry has the common shape:

```ts
{
  type: string;        // see types below
  user: string;        // who recorded it (e.g. 'Agent', 'guy')
  date: string;        // ISO-8601 timestamp
  ...                  // type-specific fields
}
```

Common requirements (validated for every entry):

- `type` non-empty string.
- `user` non-empty string.
- `date` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` and parses as a valid `Date`.

### Per-type fields

| `type` | Required extra fields | Used for |
|--------|----------------------|----------|
| `comment` | `comment: string` (non-empty) | User or agent comments in the activity feed. |
| `activity` | `comment: string` (non-empty) | Engine-recorded field changes ("Updated title."), creation activity, agent progress notes. |
| `agent_message` | `comment: string` (non-empty) | Out-of-band agent message captured outside a session. |
| `status_change` | `from: string`, `to: string` (both non-empty) | Status transitions. Old field names `oldStatus`/`newStatus` are explicitly rejected. |
| `agent_session` | `sessionId: string`, `startedAt: ISO date`, `status: string` | A CLI agent session run against the ticket. Also carries `framework`, `endedAt`, `progress[]`, token counters; written by the agent adapters. When a session reaches a terminal status, the engine **compacts** the stored `progress[]` (`compactSessionProgress` in [`history.ts`](../../../engine/src/history.ts), invoked from `updateAgentSession`): raw per-second `text` chunks are dropped in favor of typed milestones (`tool`, `topic`, `info`), error-looking entries, and the last couple of text chunks; the last text chunk is promoted to a first-class `finalMessage` field and `originalProgressCount` records the pre-compaction length. Sessions that are part of an orchestration run also carry `groupId` (shared run id), `role` (e.g. `reviewer:architect`, `orchestrator`), and `pattern` (the execution pattern) so the activity feed can render the whole run as one collapsible block. |

**Digest fields (optional, cross-cutting):** `comment`, `activity`, and `agent_session` entries may carry an optional `summary: string` and `pin: boolean`. They don't affect the file or the portal — they drive the **agent** digest (`get_ticket` / `?view=agent`): older entries with a `summary` (or, for `agent_session`, the existing `outcome`) are returned collapsed to `{ …, summary, id, collapsed: true }` instead of full text, with a `collapsedCount` reported; `pin: true` keeps an entry full regardless of age. Set them via `add_comment` / `log_progress`; recover a collapsed body with `get_ticket(…, expand: ["<id>"])`. See [MCP tools → get_ticket](mcp-tools.md#get_ticket).

Any other `type` value is rejected by the validator as `unknown history entry type`.

### Append-only and normalization

- Never delete or rewrite past entries; engine helpers always append.
- `normalizeHistoryEntries` (in [`history.ts`](../../../engine/src/history.ts)) dedupes consecutive `comment` entries from the same user with identical text, and collapses redundant `status_change` entries that don't actually change status.
- `ensureCreationActivity` guarantees the first entry is a creation `activity` entry. The engine adds this on create.

## Status transition enforcement

Validation is purely schema-shaped. **Behavioral** rules live in the MCP `change_status` tool and the REST `PUT /api/tasks/:id` handler:

- Moving **to** `Require Input` requires a `comment` (the question to ask).
- Moving **to** `Ready` requires a `comment` (the completion summary), unless `config.requireCommentOnStatusChange === false`.
- The names of these two statuses are read from `config.requireInputStatus` / `config.readyForMergeStatus` and may be renamed.

See [Reference: MCP Tools](mcp-tools.md#change_status) for the canonical enforcement description.

## Subtask conventions

- `subtasks` holds child ticket ids only. Object-form entries (`{id: 'FLUX-42'}`) are tolerated for back-compat but objects missing `id` are dropped.
- Parent relationships are derived from these links; no field on the child stores its parent. Cards compute their parent badge by reverse-lookup on the cache.
- `create_subtask` (MCP) and `POST /api/tasks/:parentId/subtasks` (REST) maintain both files atomically.

## Atomic write guarantees

All mutations go through `atomicWriteFile` in [`task-store.ts`](../../../engine/src/task-store.ts):

1. Write content to `<file>.tmp`.
2. `renameSync` over the target.
3. On cross-device-rename failure, fall back to direct write and clean up the temp file.

`readTaskFromDisk` defends against transient corrupt reads (empty file or missing `title`) by falling back to the cached copy and logging a warning.

## When in doubt

- Use [MCP tools](mcp-tools.md) — they validate and update history correctly by construction.
- Do not hand-edit `.flux/*.md` files while the engine is running unless you understand the watcher reload flow.

## Cross-references

- [Reference: MCP Tools](mcp-tools.md)
- [Reference: REST API](rest-api.md)
- [Reference: Realtime Channels](realtime-channels.md) — how schema-validated writes propagate to the UI.
- [Ticket Model](../architecture/ticket-model.md) — higher-level conceptual overview.
