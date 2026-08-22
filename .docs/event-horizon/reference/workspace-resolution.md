---
title: Workspace Resolution — Definitions of "Active"
order: 8
---
# Workspace Resolution — Definitions of "Active"

The engine can have multiple boards (workspaces) live at once (epic FLUX-1230). Before FLUX-1557, "the active workspace" had **three** different, disagreeing meanings depending on which code you were reading. This page is the single place that defines them.

## The two definitions today (FLUX-1557)

1. **Engine unbound fallback — deterministic, always the default board.**
   `getWorkspace()` ([`workspace-context.ts`](../../../engine/src/workspace-context.ts)) resolves, in order:
   - the request/tool-call-scoped binding (`runWithWorkspace`/`AsyncLocalStorage`), if one is active;
   - otherwise `defaultWorkspace` — the boot/single-board workspace, unconditionally.

   Before this ticket, the second step instead consulted `activeKey` — the root of whichever board was most recently `openWorkspace()`-d (via the S10 switcher's "open board" action, or a live tab). That made any code with **no** explicit binding (an unmigrated background loop, the portal's headerless self-fetches) silently follow whichever board the user last opened, with no way to point it back at the default board short of closing every other tab. `getWorkspace()` now logs a throttled dev warning when the unbound path is hit while other boards are registered — a sign the caller needs an explicit `runWithWorkspace` binding, not a signal to add one back.

   `activeKey` still exists and is still maintained by `openWorkspace()`/close (LRU bookkeeping), but nothing resolves through it anymore.

2. **Request-bound / per-connection — the `X-EH-Workspace` header (or `?ws=` for header-less transports) / MCP per-connection binding.**
   Every HTTP request is wrapped in `runWithWorkspace(req.workspace, …)` (`attachWorkspace` + `workspaceScope` middleware, mounted globally in `index.ts`) and every MCP call is wrapped the same way per-connection (`mcp-server.ts`'s `boundWorkspace()`). This is "the board this specific request/session targets" — the only definition that matters for correctness (ticket reads/writes, chat spawns, artifact serving). The portal's `ehFetch` (`portal/src/api.ts`) sends the **viewed** board as this header on every board-scoped request, including `fetchHealth`/`fetchWorkspaces` as of FLUX-1557 (previously headerless, so their `workspace`/`active` fields tracked the engine's now-removed `activeKey` fallback instead of what the user was looking at).

   The header value is matched against the S1 registry via `normalizeWorkspaceKey()` (`workspace-context.ts`) — realpath'd and case-folded on win32, not a bare `path.resolve()` (FLUX-1571). Every seam that stores or compares a workspace root (`addWorkspaceEntry`/`autoRegisterWorkspace` in `workspace.ts`, `resolveWorkspaceFromRoot` here, `enrichEntry`'s `active`/`open` flags in `routes/workspaces.ts`) goes through that same rule, so a root named via an 8.3 short form or a differently-cased-but-identical path still resolves to the right board instead of silently missing the lookup and falling back to the default one.

3. **Client switcher highlight — `AppStoreState.activeBoardId` (S10 switcher).**
   Purely client-side UI state: which tab is highlighted in the portal's board switcher. Not consulted by the engine at all — it's the *source* of the `X-EH-Workspace` header `ehFetch` sends (via `setActiveBoardKey`), not a separate resolution the engine performs.

## What changed vs. before

Before FLUX-1557 there was a third, conflicting definition: **"whichever board was opened most recently"** (`activeKey`), which the engine's unbound fallback consulted. That made (1) and (3) disagree constantly — opening a second board (definition 3 unaffected, still highlights whatever tab the user clicked) silently repointed every unbound engine call (definition 1, as it was) at the new board, including the portal's own headerless `fetchHealth`/`fetchWorkspaces` reads. FLUX-1548 removed the load-bearing background-loop consumers of that fallback (temper, gate-runner, scheduled-wake, Furnace stoke, PR-reconcile — all now bind explicitly via `runWithWorkspace`); FLUX-1557 removed the fallback itself, so definitions (1) and (2) now always agree for any properly-bound caller, and (1) alone (unbound) is deterministic rather than following the switcher.

## Mutations refuse an unresolved header instead of silently misfiling (FLUX-1675)

Definition (2)'s header match is a **"never an error, fall back to the default board" (FLUX-1557)** lookup — appropriate for reads, but for a *mutating* REST call (`POST`/`PUT`/`PATCH`/`DELETE`) that silent fallback means a header naming a real-but-not-yet-loaded board (the normal state for every board but the boot one, right after an engine restart) silently creates the record on the **active/default** board instead — wrong board, wrong project key, no error to notice.

`attachWorkspace` (`engine/src/middleware.ts`) now also records `req.workspaceHeaderUnresolved` when a routing value was present but matched neither `getWorkspaceByRoot` nor the default workspace's root (`isRegisteredOrDefaultRoot`, the same match rule `resolveWorkspaceFromRoot` uses). `requireWorkspace` — mounted on every workspace-scoped router — checks that flag against `req.method`: a mutating method with an unresolved header gets `400 { error, code: 'WORKSPACE_NOT_LOADED' }` and the request never reaches the route handler. `GET`/`HEAD` and a header-absent request are unaffected — they keep resolving to the default workspace exactly as before. See the [REST API error table](rest-api.md#error-shapes) for the response shape. MCP routing is unaffected by this ticket — `getRequestBinding()` (below) already discloses `'default-fallback'` to an MCP-connected agent.

## `/switch` is portal-only; index rebuilds are atomic (FLUX-1678)

Two follow-ups agreed in FLUX-1675's decision comment but not shipped there:

**Switch is a human/portal-only action.** `POST /api/workspaces/switch` rebinds `getWorkspaceRoot()` — the legacy single-active board every portal client without an explicit `X-EH-Workspace` binding sees — so it's global, all-clients-visible mutation, not per-request routing. `isAgentAuthenticatedRequest(req)` (`engine/src/middleware.ts`) refuses it with `403 { code: 'SWITCH_PORTAL_ONLY' }` whenever the request carries `x-eh-conversation-id` or `x-eh-session-id` — the same headers EH agent clients always set and the portal's `switchWorkspace` (raw `fetch`, no custom headers) never sends. A headerless request (curl, or the portal) is unaffected, consistent with EH's trusted-localhost model (`loopbackOnly`, `engine/src/middleware.ts`) — no HMAC/signature check, since mere header presence already distinguishes portal from agent. An agent that needs a specific board routes by `X-EH-Workspace` per definition (2) above instead. `/open` and `/close` are unaffected — `/open` is the agent-safe non-destructive path.

**Index rebuilds never expose an empty/partial workspace.** Before FLUX-1678, `doActivateWorkspace` cleared `ws.tasks`/`ws.docs`/`ws.parseErrors` up front and refilled them asynchronously via `initDir()` — a read landing mid-scan (`GET /api/tasks/:id`, MCP `get_ticket`/`list_tickets`, all of which read `ws.tasks` directly, unguarded by the `isActivating` 503 that only covers `GET /api/tasks`) served 404 for a ticket whose file was intact on disk the entire time. `reloadWorkspaceIndex()` (`engine/src/task-store.ts`) replaces the clear-then-fill with **upsert-then-prune**: `initDir()` now returns the set of ticket ids actually found on disk this scan, and `ws.tasks`/`ws.parseErrors` entries whose id isn't in that set are deleted only *after* the scan completes. A concurrent reader therefore only ever observes the complete pre-reload set (however stale, e.g. the outgoing board's during a switch) or the complete post-reload set — never a gap. This also fixes `POST /api/workspaces/open` on an already-open board: it used to no-op unconditionally (`if (ws.fluxWatcher) return ws`), so a stale index could only be recovered by a destructive close+open cycle — it now calls `openWorkspaceLive(root, { reload: true })`, which rescans atomically without re-creating watchers or re-running bootstrap. `ws.docs` still gets a fresh clear on activation — doc-index atomicity is out of this fix's scope.

## Disclosure to MCP clients (FLUX-1573)

Definitions (1) and (2) above matter to the *engine*, but until FLUX-1573 an MCP-connected agent had no way to ask which one it landed on. A hand-launched session using a repo's static `.mcp.json` sends no `X-EH-Workspace` header, so it silently resolves via definition (1) (the boot/default board) with no signal that it never went through (2) at all — the failure mode behind a misbound orchestrator confabulating its binding and mutating the wrong board.

`getRequestBinding()` (`workspace-context.ts`) exposes which definition resolved the current call: `'header'` when inside a non-null `runWithWorkspace` binding (definition 2), `'default-fallback'` when unbound (definition 1). This, plus the bound `workspaceRoot` (canonicalized) and `storeMode` (`isOrphanMode()`), are surfaced on [`get_board_config`/`board://config`](mcp-tools.md#get_board_config) and stamped into the per-session MCP `instructions` block, so every session sees its own binding without a tool call. The companion read-only [`list_workspaces`](mcp-tools.md#list_workspaces) tool lists every registered board's `canonicalRoot` — the exact value to copy into an `X-EH-Workspace` header to target one deliberately. See `mcp-tools.md` for the full field/tool contract.
