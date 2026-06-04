---
title: REST API Reference
order: 2
---
# REST API Reference

Authoritative list of HTTP endpoints exposed by the engine on `http://localhost:3067`. The REST surface is primarily for the portal; agents should use the [MCP tools](mcp-tools.md) instead.

> Both REST and MCP read and write the same in-memory `tasksCache` in [`task-store.ts`](../../../engine/src/task-store.ts) and persist through the same atomic write path. Mutations broadcast SSE events on `/api/events` so the portal updates live.

## Conventions

- All routes are mounted under `/api/*` from [`engine/src/index.ts`](../../../engine/src/index.ts).
- Routes marked **workspace-scoped** below sit behind the `requireWorkspace` middleware. If no workspace is active, they return `503` with `{ error: 'NO_WORKSPACE' }`. The portal intercepts this and shows the workspace picker.
- Request bodies are JSON unless noted. Body size limit is 10 MB.
- Success responses are JSON unless noted.
- Mutation endpoints append entries to ticket history and broadcast SSE events (`taskCreated`, `taskUpdated`, `taskDeleted`).

## Server-level

| Method | Path | Workspace? | Purpose |
|--------|------|-----------|---------|
| GET | `/api/health` | no | `{ status: 'ok', workspace: <root \| null> }` |
| POST | `/api/shutdown` | no | Stop all CLI sessions and exit the process |
| GET | `/api/update-check` | no | Cached update-availability snapshot |

## Tasks (`/api/tasks`) — workspace-scoped

Sourced from [`engine/src/routes/tasks.ts`](../../../engine/src/routes/tasks.ts) and [`cli-session.ts`](../../../engine/src/routes/cli-session.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tasks` | All tickets (array). The portal polls this. |
| GET | `/api/tasks/errors` | Parse errors keyed by file path — for the ParseError banner. |
| GET | `/api/tasks/:id` | Single ticket. |
| POST | `/api/tasks` | Create a ticket. Body: `{ author, title, status?, priority?, effort?, tags?, body?, assignee?, history?, projectKey?, ... }`. Allocates next id from `projectKey` (or first configured project), checks remote ids in orphan mode to avoid collisions, validates schema, writes atomically. Returns the created ticket. |
| POST | `/api/tasks/:parentId/subtasks` | Create a child ticket and link it from the parent. Body mirrors POST `/api/tasks` plus parent linkage. |
| PUT | `/api/tasks/:id` | Update a ticket. Body: any subset of metadata fields, optional `body`, optional `status`, optional `appendHistory: HistoryEntry[]` to append comments / activity entries. Used by the portal and as the REST fallback for agents when MCP is unavailable. |
| DELETE | `/api/tasks/:id` | Delete a ticket. Removes the markdown file, unlinks from parent `subtasks`, deletes asset directory if present. |
| POST | `/api/tasks/:id/assets` | Upload an image asset. Body: `{ filename, contentBase64 }`. Writes under `.flux/assets/<ticket-id>/<unique-name>`. Returns the relative markdown path the caller should embed. |
| POST | `/api/tasks/:id/branch` | Create a git branch for the ticket. Body: `{ baseBranch? }`. |
| GET | `/api/tasks/:id/branch` | Get branch status (`{ name, exists, aheadCount, behindCount }`). |
| DELETE | `/api/tasks/:id/branch` | Delete the ticket's branch. Body: `{ force? }`. |
| GET | `/api/tasks/:id/diff` | Fetch the unified diff sidecar captured at `finish_ticket`. Optional `?file=<path>` query returns only that file's hunk. 404 when no diff is stored. Response is `text/plain`. |
| POST | `/api/bulk-rename` | Rename a status or tag across every ticket. Body: `{ kind: 'status' \| 'tag', from, to }`. Mounted at top level, not under `/api/tasks`, but lives in the same module. |

### CLI session sub-routes (mounted under `/api/tasks`)

From [`cli-session.ts`](../../../engine/src/routes/cli-session.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tasks/:id/cli-session` | Most recent CLI session summary for a ticket. |
| GET | `/api/tasks/:id/cli-sessions` | All session summaries for a ticket. |
| POST | `/api/tasks/:id/cli-session/start` | Launch a CLI agent (Claude / Gemini / Copilot) against the ticket. Body: `{ framework, appendPrompt?, effortOverride?, skipPermissions?, role?, pattern?, patternPosition?, groupId?, groupSeq?, groupType?, groupVariant?, lockedPaths? }`. Multi-session fields (`role`, `pattern`, `patternPosition`) tag the session for orchestration. Run-group fields (`groupId`, `groupSeq`, `groupType`, `groupVariant`) bind sessions launched together into one orchestration run so the UI can render them as a cluster. `lockedPaths` declares exclusive file access; engine returns 409 on conflicts. Spawns the child process; live output streams over SSE. |
| POST | `/api/tasks/:id/cli-session/input` | Send follow-up input to a running session. Body: `{ message, user?, sessionId? }`. `sessionId` targets a specific session in a multi-agent run; omit to target the most recent active session. |
| POST | `/api/tasks/:id/cli-session/stop` | Cancel a running session. Body: `{ sessionId? }`. `sessionId` stops one agent in a run group; omit to stop the most recent active session. |

## Docs (`/api/docs`) — workspace-scoped

From [`routes/docs.ts`](../../../engine/src/routes/docs.ts). Docs paths use a regex route to accept slashes inside the path.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/docs` | Docs tree (folders + files with frontmatter). |
| POST | `/api/docs` | Create a doc. Body: `{ path, title?, body?, order? }`. |
| GET | `/api/docs/<any/path>` | Read a doc by path. |
| PUT | `/api/docs/<any/path>` | Update a doc body / frontmatter. Body: `{ title?, body?, order? }`. |
| DELETE | `/api/docs/<any/path>` | Delete a doc. |

## Config (`/api/config`) — workspace-scoped

From [`routes/config.ts`](../../../engine/src/routes/config.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/config` | Current board config (columns, hidden statuses, tags, priorities, users, project keys, sync settings, …). |
| PUT | `/api/config` | Replace the board config. |

## Workspace + workspaces

| Method | Path | Workspace? | Purpose |
|--------|------|-----------|---------|
| POST | `/api/workspace/pick` | no | Open the native folder picker and activate the chosen folder. |
| GET | `/api/workspace` | no | Current active workspace info `{ root, name, mode, … }`. |
| POST | `/api/workspace` | no | Activate a workspace by absolute path. |
| GET | `/api/workspace/health` | no | Validation: does the path exist, is it a real workspace, etc. |
| GET | `/api/workspaces` | no | Registered workspaces list (from global settings). |
| POST | `/api/workspaces` | no | Add a new workspace to the registry. |
| DELETE | `/api/workspaces/:index` | no | Remove a workspace by index. |
| PUT | `/api/workspaces/:index` | no | Rename a workspace. |
| POST | `/api/workspaces/switch` | no | Switch active workspace. Refuses if active CLI sessions are running unless overridden. |

## Settings (`/api/settings`)

From [`routes/settings.ts`](../../../engine/src/routes/settings.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings/boot-status` | First-boot dialog state and legacy-migration status. |
| POST | `/api/settings/confirm-boot` | Mark first-boot acknowledged. |
| GET | `/api/settings/global` | Global app settings (theme, defaultUser, preferredFramework, port, animations, timeouts, …). |
| PUT | `/api/settings/global` | Update global settings. |

## Read-state (`/api/read-state`) — workspace-scoped

Tracks which ticket history entries the current user has seen so unread badges work.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/read-state` | Per-ticket read offsets. |
| PUT | `/api/read-state` | Replace or merge read offsets. |

## Notifications (`/api/notifications`)

From [`routes/notifications.ts`](../../../engine/src/routes/notifications.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/notifications` | All current notifications. |
| POST | `/api/notifications/read-all` | Mark all read. |
| POST | `/api/notifications/check-health` | Run a notification-source health pass (e.g. skill-staleness checks). |
| POST | `/api/notifications/:id/read` | Mark one read. |
| POST | `/api/notifications/:id/dismiss` | Dismiss one. |
| POST | `/api/notifications/:id/action` | Trigger a notification's primary action (e.g. install skill). |

## Storage / sync — workspace-scoped

From [`routes/storage.ts`](../../../engine/src/routes/storage.ts) and [`routes/sync-status.ts`](../../../engine/src/routes/sync-status.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/storage/mode` | `{ mode: 'in-repo' \| 'orphan-branch', … }`. |
| POST | `/api/storage/migrate` | Migrate from in-repo `.flux/` to orphan-branch `.flux-store/`. |
| POST | `/api/storage/restore` | Restore tickets from a known sync state. |
| POST | `/api/storage/resolve-conflicts` | Apply user choices to merge conflicts surfaced by the sync watcher. |
| GET | `/api/sync-status` | Current sync state (`idle`, `syncing`, `synced`, `conflict`, `error`). |
| POST | `/api/sync-status/sync` | Force an immediate sync. |
| POST | `/api/sync-status/test-error` | Inject a fake error state — UI development only. |
| GET | `/api/sync-status/stream` | SSE stream of sync status changes. |

## Skill installer (`/api/skill`) — workspace-scoped

From [`routes/skill.ts`](../../../engine/src/routes/skill.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/skill/status` | Per-framework install status and staleness. |
| POST | `/api/skill/install` | Install the workflow skill + MCP config for the chosen framework. Body: `{ framework: 'auto' \| 'claude' \| 'copilot' \| 'gemini' \| 'cursor' \| 'windsurf' \| 'generic', force? }`. |

## Workflows (`/api/workflows`)

Multi-agent execution patterns (relay, scatter-gather, supervisor). From [`routes/workflows.ts`](../../../engine/src/routes/workflows.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/workflows` | List workflows. |
| GET | `/api/workflows/patterns` | List available execution patterns. |
| GET | `/api/workflows/:id` | One workflow. |
| POST | `/api/workflows` | Create. |
| PUT | `/api/workflows/:id` | Update. |
| DELETE | `/api/workflows/:id` | Delete. |

## Agents (`/api/agents`)

Per-agent metadata used by the launcher UI. From [`routes/agents.ts`](../../../engine/src/routes/agents.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agents` | List agents. |
| GET | `/api/agents/:id` | One agent. |
| POST | `/api/agents` | Create. |
| PUT | `/api/agents/:id` | Update. |
| DELETE | `/api/agents/:id` | Delete. |

## Stats (`/api/stats`) — workspace-scoped

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/stats/tokens` | Lifetime token + cost stats aggregated from CLI session history. |

## Assets (`/api/assets`)

From [`routes/assets.ts`](../../../engine/src/routes/assets.ts). Mounted with a permissive path regex.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/assets/<any/path>` | Stream a file from the workspace asset tree (`.flux/assets/`). Used by markdown image rendering. |

## Events (`/api/events`) — workspace-scoped

From [`routes/events.ts`](../../../engine/src/routes/events.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/events` | SSE stream of `taskCreated`, `taskUpdated`, `taskDeleted`, parse errors, sync status, and notifications. |

## Error shapes

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{ error: 'SCHEMA_VALIDATION_FAILED', message, details }` | Frontmatter would be invalid |
| 404 | `{ error: 'Not found' }` | Ticket / doc id unknown |
| 409 | `{ error: 'CONFLICT', ... }` | Sync conflict requires resolution |
| 503 | `{ error: 'NO_WORKSPACE' }` | `requireWorkspace` middleware — pick a workspace first |
| 503 | `{ error: 'Workspace is activating, please retry' }` | Workspace switch in progress |
| 500 | `{ error: <message> }` | Unhandled |

## Cross-references

- [Reference: MCP Tools](mcp-tools.md) — the agent-facing surface that shares state with this API.
- [Architecture Overview](../architecture/overview.md) — runtime layout, workspace model.
- [Code Map](../architecture/code-map.md) — file ownership of each subsystem.
