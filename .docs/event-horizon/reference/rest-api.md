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
| GET | `/api/tasks` | All tickets (array). The portal polls this. Each ticket carries a **capped** `cliSessions[]`: only active sessions plus the most-recent completed run group, with each `liveOutput` truncated to a short tail (~2KB) — so the poll payload doesn't grow with session history. Use `GET /api/tasks/:id` for the full set. |
| GET | `/api/tasks/errors` | Parse errors keyed by file path — for the ParseError banner. |
| GET | `/api/tasks/:id` | Single ticket. Returns the **full** `cliSessions[]` (all sessions, full `liveOutput`). |
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
| POST | `/api/tasks/:id/cli-session/start` | Launch a CLI agent (Claude / Gemini / Copilot) against the ticket. Body: `{ framework, appendPrompt?, personaId?, focusComment?, effortOverride?, skipPermissions?, role?, pattern?, patternPosition?, groupId?, groupSeq?, groupType?, groupVariant?, lockedPaths? }`. `personaId` resolves a reviewer/orchestrator prompt **server-side** from the persona catalog (see `/api/orchestration/personas`); `focusComment` is an optional reviewer focus note appended to the resolved prompt. Provide either `appendPrompt` or `personaId` (an unknown `personaId` returns 400). Multi-session fields (`role`, `pattern`, `patternPosition`) tag the session for orchestration. Run-group fields (`groupId`, `groupSeq`, `groupType`, `groupVariant`) bind sessions launched together into one orchestration run so the UI can render them as a cluster. `lockedPaths` declares exclusive file access; engine returns 409 on conflicts. Spawns the child process; live output streams over SSE. |
| POST | `/api/tasks/:id/cli-session/input` | Send follow-up input to a running session. Body: `{ message, user?, sessionId? }`. `sessionId` targets a specific session in a multi-agent run; omit to target the most recent active session. |
| POST | `/api/tasks/:id/cli-session/register-combiner` | Register a **deferred combiner** for a scatter-gather run group. Body: `{ framework, groupId, role, appendPrompt?, personaId?, expectedWorkers, skipPermissions?, groupType?, groupVariant? }`. Provide either `appendPrompt` or `personaId` (resolved server-side; typically `'orchestrator'`). The combiner is spawned by the engine's fan-in barrier only once every worker (`patternPosition: 'step'`) session in `groupId` reaches a terminal state — preventing the combiner from racing its workers. `expectedWorkers` guards against launching before all workers have registered. Registering re-checks immediately in case workers already finished. |
| POST | `/api/tasks/:id/cli-session/unregister-combiner` | Cancel a pending deferred combiner. Body: `{ groupId }`. Used when no worker sessions actually started. |
| POST | `/api/tasks/:id/cli-session/stop` | Cancel a running session. Body: `{ sessionId? }`. `sessionId` stops one agent in a run group; omit to stop the most recent active session. |

## Orchestration (`/api/orchestration`) — workspace-scoped

From [`orchestration.ts`](../../../engine/src/routes/orchestration.ts). Persona prompts live engine-side in [`orchestration-personas.ts`](../../../engine/src/orchestration-personas.ts) and are resolved server-side at launch from a `personaId`. Built-in personas are defined in code, maintained by Event Horizon, and are **viewable but read-only** (so users can read and fork them); user-authored personas persist as JSON files under `<fluxDir>/personas/*.json` and are fully editable. Both are merged at read time.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/orchestration/personas` | List selectable personas as metadata only: `{ personas: Array<{ id, label, description, phase, compatiblePatterns, requiredCapabilities, builtIn }> }`. Prompt text is omitted. `phase` (`grooming` \| `implementation` \| `review` \| `finalize`) drives phase-aware launcher filtering; pass `?phase=<phase>` to return only personas for that phase. `compatiblePatterns` gates a persona to specific execution patterns (empty = any); `requiredCapabilities` lists CLI capabilities a persona needs; `builtIn` flags code-defined (read-only) personas. The internal `orchestrator` and `supervisor` personas are excluded from this list (they are added automatically by the launcher when the pattern requires a combiner/lead). |
| GET | `/api/orchestration/personas/:id` | Full persona **including prompt** (`{ persona }`), for both built-in and custom personas. The `builtIn` flag tells the client whether to render it read-only; the portal offers a "Duplicate & Edit" fork for built-ins. |
| POST | `/api/orchestration/personas` | Create a custom persona. Body: `{ id?, label, description?, phase, compatiblePatterns?, requiredCapabilities?, prompt }`. `id` is auto-validated as a slug; an id that collides with a built-in returns 400. Returns `{ persona }` (metadata). |
| PUT | `/api/orchestration/personas/:id` | Update a custom persona (same body as POST). Refuses built-in ids with 400 — built-ins are maintained in code and updated via app releases. Returns `{ persona }` (metadata). |
| DELETE | `/api/orchestration/personas/:id` | Delete a custom persona. Refuses built-in ids with 400; returns 404 if not found. |

## Docs (`/api/docs`) — workspace-scoped

From [`routes/docs.ts`](../../../engine/src/routes/docs.ts). Docs paths use a regex route to accept slashes inside the path.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/docs` | Docs tree (folders + files with frontmatter). |
| POST | `/api/docs` | Create a doc. Body: `{ path, title?, body?, order? }`. A path under the group docs label (`Product/…`, or the group's `docsLabel`) is routed to the canonical `.flux-group` store: the **parent** writes in place and the **member** pushes through the parent — both commit + fan out. Returns **403** only when no group writer is resolvable. |
| GET | `/api/docs/<any/path>` | Read a doc by path. |
| PUT | `/api/docs/<any/path>` | Update a doc body / frontmatter. Body: `{ title?, body?, order? }`. A **group** doc (`doc.group`) is written through the canonical store writer — the parent edits its own group docs inline (FLUX-414), a member pushes through the parent — then fans out. Returns **403** only when no group writer is resolvable. |
| DELETE | `/api/docs/<any/path>` | Delete a doc. A **group** doc is deleted through the canonical store writer (parent in place, member push-through-parent) and fanned out. Returns **403** only when no group writer is resolvable. |
| POST | `/api/docs/rename-folder` | Rename a docs folder by rewriting the path prefix of every **local** doc beneath it. Body: `{ from, to }` (both normalized doc paths). Refuses to move a folder into itself or onto an existing doc (**409** collision), and rejects the group docs label tree (`docsLabel/…`) — renaming that is a `docsLabel` change via `PATCH /api/group/docs-label`, not a file move. Returns `{ success, moved: [{ from, to }] }`. |

> Cross-project group docs (multi-repo groups) surface in the tree under the synthetic `Product/` prefix with `readOnly: true` and `group: true`. They are loaded from the canonical group store and are not editable in-place — edits route through the parent repo (see [multi-repo groups](../architecture/multi-repo-groups.md)).

## Config (`/api/config`) — workspace-scoped

From [`routes/config.ts`](../../../engine/src/routes/config.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/config` | Current board config (columns, hidden statuses, tags, priorities, users, project keys, sync settings, …). Includes `defaultAgent`, the legacy `defaultWorkflowId`, and `phaseDefaults` — a map of `{ grooming, implementation, review, finalize } → { single?, multi? }` template ids that drive the per-phase Single/Multi launch defaults (each falls back to `builtin-<phase>-<variant>` when unset). |
| PUT | `/api/config` | Replace the board config. |

## Workspace + workspaces

| Method | Path | Workspace? | Purpose |
|--------|------|-----------|---------|
| POST | `/api/workspace/pick` | no | Open the native folder picker and activate the chosen folder. |
| GET | `/api/workspace` | no | Current active workspace info `{ root, name, mode, … }`. |
| POST | `/api/workspace` | no | Activate a workspace by absolute path. |
| GET | `/api/workspace/health` | no | Validation: does the path exist, is it a real workspace, etc. |
| GET | `/api/workspaces` | no | Registered workspaces list (from global settings). Each entry carries an optional `group` descriptor (`{ groupName, role: 'parent' \| 'member', parentPath, memberName? }`, FLUX-415) so the portal can render multi-repo groups nested together. |
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

## Group (`/api/group`) — workspace-scoped

From [`routes/group.ts`](../../../engine/src/routes/group.ts). Multi-repo group setup (recreatability). `plan` is a read-only dry run; `apply` performs the writes.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/group` | Current group status (mirrors the `get_project_group` MCP tool — `{ configured, … }`). Includes `docsLabel` (the surfaced group docs prefix — `group.json`'s `docsLabel` or the default `Product`). When the workspace is the parent or a reverse-lookup-bound member, the response also carries `membership: { role: 'parent' \| 'member', groupName, parentRoot, memberName?, memberRole? }`. A bound **member** still reports `configured: false` (parent-only operations stay parent-only) — `membership` is the signal that the repo belongs to a group. |
| POST | `/api/group/plan` | Compute the intrusive actions (write `group.json`, patch `.gitignore`, scaffold store, register/clone members) with **zero git mutation**. Body: `{ name, members: [{ name, role, remote, testCommand? }], force?, allowLocalRemotes? }`. Returns a `GroupSetupPlan`. |
| POST | `/api/group/apply` | Perform the planned writes. Same body as `plan`. Per-member isolation; returns a `GroupSetupResult` with a per-member `{ ok, error? }` aggregate. Refuses to overwrite an existing `group.json` without `force`. |
| POST | `/api/group/ensure-registered` | Idempotent **backfill**: register the dedicated parent + present members as workspaces so the Case-1 member binding can resolve, without re-running setup or rewriting `group.json`. No body. Resolves the group from the active parent context or a bound member's parent. Returns an `EnsureRegisteredResult` (`{ complete, registrations: [{ kind, path, alreadyRegistered, ok }] }`). |
| GET | `/api/group/discover/registry` | Discovery source for the onboarding wizard: the repos EH already knows (workspace registry), each as `{ path, name, remote, registered, isGroupParent }`. Read-only. |
| POST | `/api/group/discover/folder` | Discovery source: scan a folder for **immediate-child** git repos (no recursion, skips `node_modules`/`.git`/`.flux-group`/etc.). Body: `{ folder }`. Returns `{ folder, repos: DiscoveredRepo[] }`. Read-only. |
| POST | `/api/group/create-parent` | Create a brand-new **dedicated parent** repo to host a group (mkdir + `git init` + scaffold store + write `group.json` + register **parent and members**). Body: `{ parentPath, name, members: [{ name, role, remote, testCommand?, path? }] }` — each member's `path` is its local checkout (from discovery). Pins those paths in a gitignored `group.local.json` so the parent resolves members regardless of layout, registers every member whose path is checked out, and refuses to clobber an existing `group.json`. Returns `{ parentRoot, groupName, gitInitialized, wroteConfig, wroteLocalConfig, scaffoldedStore, registered, memberRegistrations: [{ name, path, registered, reason? }] }`. |
| POST | `/api/group/sync` | Fan out the canonical group docs to every member. Promotes `.flux-group` to a worktree on the `flux-group-docs` orphan branch, commits any pending doc changes, then pushes that branch **by declared remote URL** to each member (fast-forward only — never `--force`). No body. Returns a `GroupSyncResult`: `{ committed, pushed, failed, members: [{ name, remote, ok, diverged?, error? }] }`. Per-member isolation; a diverged member is reported (`diverged: true`) without aborting the others. |
| POST | `/api/group/submit-edit` | Push-through-parent intake: apply a sub-repo doc edit into the canonical store, commit, and re-fan-out. Body: `{ files: [{ path, content?, delete? }] }` — `path` is store-relative (absolute paths, `..` traversal, and `.git` writes are rejected). Submissions are **serialized** at the parent (sole writer). Returns `{ applied: string[], sync: GroupSyncResult }`. Because no member advances the branch, every re-fan-out push stays fast-forward. |
| POST | `/api/group/promote-docs/plan` | Dry run: walk this repo's `.docs/` and propose a store-relative target per file (default `features/<basename>`, retargetable). No body, zero mutation. Returns `{ parentRoot, candidates: [{ source, target }] }`. Works from **either side of a group** — a parent or a reverse-lookup-bound member (resolved via `getGroupContext()` ?? `getMemberBinding()`); a standalone workspace gets "needs a group". |
| POST | `/api/group/promote-docs/apply` | Promotion with **move semantics**, runnable from **parent or member**. **Parent:** write each selected `.docs/` file into the canonical store, `git rm` it from main, commit the removals, then `syncGroup` (commit on `flux-group-docs` + fan out). **Member:** read its own `.docs/` and push the content into the store **through the parent** (`submitGroupEdit` — the same serialized intake member doc edits use), then `git rm` each source from the member's own main; the doc returns as a read-only group doc. Body: `{ selections: [{ source, target }] }` (`source` under `.docs/`, `target` store-relative; `..`/absolute/`.git` rejected). Per-file isolation. Returns `{ promoted: string[], failed: [{ source, target, error }], sync: GroupSyncResult }`. A promoted doc is no longer on the originating repo's main. |
| PATCH | `/api/group/docs-label` | **Parent-only** rename of the surfaced group docs folder. Body: `{ label }` (a single safe path segment). Rewrites `group.json`'s `docsLabel` and reloads the group config so the new prefix takes effect live — a display-prefix change only, it never moves stored files. Returns `{ ok, docsLabel }`. New groups derive this label from the group name (`deriveDocsLabel`) at creation, falling back to `Product`. |


Every member `remote` is validated before it reaches git (rejects shell metacharacters, `ext::`/`fd::` transports, and embedded `--upload-pack`/`--receive-pack`). The `init-group` CLI (`npm run init-group`) calls the same engine routine headlessly.

## Skill installer (`/api/skill`) — workspace-scoped

From [`routes/skill.ts`](../../../engine/src/routes/skill.ts).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/skill/status` | Per-framework install status and staleness. |
| POST | `/api/skill/install` | Install the workflow skill + MCP config for the chosen framework. Body: `{ framework: 'auto' \| 'claude' \| 'copilot' \| 'gemini' \| 'cursor' \| 'windsurf' \| 'generic', force? }`. |

## Workflows (`/api/workflows`)

Multi-agent execution patterns (relay, scatter-gather, supervisor). From [`routes/workflows.ts`](../../../engine/src/routes/workflows.ts). Templates are either **built-in** (code-defined in [`models/workflow.ts`](../../../engine/src/models/workflow.ts) `BUILTIN_WORKFLOWS`, maintained by Event Horizon and updated via releases) or **custom** (persisted as JSON under `<fluxDir>/workflows/*.json`). Built-ins ship a single-agent and a multi-agent template per phase (`builtin-<phase>-single`, `builtin-<phase>-multi`) and carry `builtIn: true`. Both kinds are merged at read time; built-ins always lead the list.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/workflows` | List workflows (built-in + custom). Each item carries `builtIn` (`true` for code-defined templates). |
| GET | `/api/workflows/patterns` | List available execution patterns. |
| GET | `/api/workflows/:id` | One workflow (built-in or custom). |
| POST | `/api/workflows` | Create a custom template. An `id` that collides with a built-in is rejected. |
| PUT | `/api/workflows/:id` | Update a custom template. Refuses built-in ids with 400 — duplicate a built-in to customize it. |
| DELETE | `/api/workflows/:id` | Delete a custom template. Refuses built-in ids with 400. |

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
