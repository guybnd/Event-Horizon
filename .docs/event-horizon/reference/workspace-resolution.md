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
