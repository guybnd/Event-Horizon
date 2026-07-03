---
title: Recipes
order: 6
---
# Recipes

Task-oriented walkthroughs for common changes. Each recipe lists the exact files to touch, in the order that minimises rework, and what to verify before opening a PR.

These are starting points — read the linked reference pages for the canonical contracts.

---

## 1. Add a ticket field

Goal: surface a new piece of structured data on every ticket (e.g. `severity`).

1. **Schema** — [`engine/src/schema.ts`](../../engine/src/schema.ts)
   - Decide required vs optional. Add validation to `validateTicketFrontmatter` only if the field is required or has a constrained shape (e.g. enum, array).
2. **TypeScript type** — [`portal/src/types.ts`](../../portal/src/types.ts) `interface Task`
   - Add the field. Keep it optional unless every existing ticket already has it.
3. **API serialization** — [`engine/src/routes/tasks.ts`](../../engine/src/routes/tasks.ts)
   - Confirm the serializer passes the new field through. If you use a denylist style serializer (the current pattern), no change is needed. If you use an allowlist, add the field.
4. **Mutation surface**:
   - REST: [`PUT /api/tasks/:id`](reference/rest-api.md#put-apitasks-id) accepts arbitrary fields — verify it persists.
   - MCP: extend `update_ticket` input schema in [`engine/src/mcp-server.ts`](../../engine/src/mcp-server.ts) if agents should be able to set the field directly. See [Reference: MCP Tools](reference/mcp-tools.md#update_ticket).
5. **UI**:
   - Display: [`portal/src/components/TaskCard.tsx`](../../portal/src/components/TaskCard.tsx) (board view) and [`TaskModal.tsx`](../../portal/src/components/TaskModal.tsx) (detail view).
   - Editing: add a control inside `TaskModal`. Save with `updateTask(id, { <field>: value })` via [`portal/src/api.ts`](../../portal/src/api.ts).
6. **Docs**:
   - Add a row to the field table in [Ticket Schema](reference/ticket-schema.md).
   - If it changes how a ticket is reasoned about, mention it in [Ticket Model](architecture/ticket-model.md).

**Verify**:

- Create a ticket via MCP, set the field, reload — value persists.
- Hand-edit a `.flux/*.md` file to set the field, watch the portal pick it up within 3s.
- Set an invalid value via the REST API — engine returns `SCHEMA_VALIDATION_FAILED`.

---

## 2. Add an MCP tool

Goal: expose a new capability to agents (e.g. a new `action` on `archive`, or a brand-new tool).

1. **Tool definition** — [`engine/src/mcp-server.ts`](../../engine/src/mcp-server.ts)
   - Define the zod input schema. Match the style of existing tools — required ids by string, optional fields nullable.
   - Implement the handler. Reuse helpers from `task-store.ts` (`updateTaskWithHistory`, `loadTask`) rather than touching files directly.
   - End the handler with `broadcastEvent('taskUpdated', { id })` so live UI consumers see the change.
   - Return `{ ok: true, ... }` on success and throw `McpError` with a meaningful `code` on failure (see existing tools for the pattern).
2. **REST mirror (optional)** — [`engine/src/routes/tasks.ts`](../../engine/src/routes/tasks.ts) or a new route module under `engine/src/routes/`
   - Only add if a non-MCP client (portal, CI, etc.) needs the operation. Most tools don't need this — the portal already covers the common cases via existing routes.
3. **Docs**:
   - Add the tool's section to [Reference: MCP Tools](reference/mcp-tools.md).
   - If the tool changes a status workflow, update [Workflow](workflow/ticket-interactions.md) too.

**Verify**:

- Run `engine/scripts/build.js`, restart the engine, connect via MCP, call the tool, inspect the resulting ticket file.
- Confirm the SSE broadcast fires by watching `curl -N http://localhost:3067/api/events`.

---

## 3. Add a status (with enforcement)

Goal: add a new column to the board, optionally with a required-comment rule on entry.

1. **Board config** — done at runtime, not in code.
   - `PUT /api/config` with the new status added to `statuses[]`. (As of FLUX-770 the portal's Settings → Board editor is **recolor-only** — statuses can't be added or renamed from the UI, because the workflow engine and agent instructions are written around the canonical set. Adding one is an advanced API/config operation, and agent flows have no defined behavior for a non-canonical status — it renders as a plain lane.)
   - If the new status is hidden (Backlog/Released style), add it to `hiddenStatuses[]`.
2. **Enforcement** — [`engine/src/mcp-server.ts`](../../engine/src/mcp-server.ts) and [`engine/src/routes/tasks.ts`](../../engine/src/routes/tasks.ts)
   - The current required-comment rules look up `config.requireInputStatus` and `config.readyForMergeStatus`. If your new status should require a comment, the simplest path is to make it one of those two and rename the existing one. Otherwise, extend the check to accept a list.
3. **Renames** — if you renamed an existing status, hit `POST /api/bulk-rename` to migrate every ticket atomically.
4. **Styling** — [`portal/src/statusStyles.ts`](../../portal/src/statusStyles.ts)
   - Pick a color / accent. Falls back to a default if you skip this, but the board looks inconsistent.
5. **Workflow docs** — update the status table in [Workflow](workflow/workflow-install.md) and [Ticket Lifecycle](workflow/ticket-lifecycle.md).

**Verify**:

- New column renders on the board.
- Moving a ticket into it via MCP `change_status` honours the comment requirement.
- Hand-create a ticket with the new status — it loads cleanly.

---

## 4. Add an agent framework

Goal: register a new CLI coding agent (e.g. `cursor-agent`).

See the full step-by-step in [Reference: Agent Adapter Contract — Adding a new framework](reference/agent-adapter-contract.md#adding-a-new-framework). Short version:

1. Add the framework to `CliFramework` and the `CLI_CAPABILITIES` table in [`engine/src/agents/types.ts`](../../engine/src/agents/types.ts).
2. Implement `AgentAdapter` in `engine/src/agents/<framework>.ts`. Steal the structure of [`claude-code.ts`](../../engine/src/agents/claude-code.ts).
3. Register in [`engine/src/agents/index.ts`](../../engine/src/agents/index.ts).
4. Add a portal entry in [`FrameworkSelector.tsx`](../../portal/src/components/FrameworkSelector.tsx).
5. Update [Agent Integrations](agent-integrations.md) and the Adapter Contract reference page.

**Verify**: end-to-end session against a real ticket — `agent_session` history entry written, `activity`/`progress` SSE visible, tokens recorded, exit cleanup runs.

---

## 5. Add a portal screen

Goal: add a top-level view (e.g. a "Burndown" page).

1. **Component** — `portal/src/components/<Name>Screen.tsx`
   - Pattern: pull data from `useAppContext()` for tasks/config; call `api.ts` helpers for anything not in context.
2. **Routing** — there is no router today; screens are switched via the `currentScreen` state in [`AppContext.tsx`](../../portal/src/AppContext.tsx).
   - Add a string literal to the `Screen` union type.
   - Render the component in `App.tsx` under a new conditional branch.
3. **Navigation** — [`portal/src/components/Header.tsx`](../../portal/src/components/Header.tsx)
   - Add a nav button that calls `setCurrentScreen('<name>')`.
4. **Data fetching** — if the screen needs server data not already in context:
   - Add a route module under [`engine/src/routes/`](../../engine/src/routes/), register it in `engine/src/index.ts`, and add a client function to [`portal/src/api.ts`](../../portal/src/api.ts).
   - Document the new endpoint in [Reference: REST API](reference/rest-api.md).
5. **Realtime** — if you need live updates beyond the 3s task poll, see [Reference: Realtime Channels](reference/realtime-channels.md).

**Verify**: navigate to the screen, refresh the page (state should persist via context init), check dev tools for unexpected fetches.

---

## 6. Change a history entry shape

Goal: add a field to an existing entry type (e.g. add `severity` to `comment`), or add a new entry type entirely.

1. **Validator** — [`engine/src/schema.ts`](../../engine/src/schema.ts) `validateHistoryEntry`
   - Add the case (new type) or the field check (extend existing case).
   - The validator runs on every read/write — be careful with backwards compatibility. Optional fields are safest.
2. **Builder** — [`engine/src/history.ts`](../../engine/src/history.ts)
   - Add a `build<Type>Entry` helper if it's a new type. Match the style of `buildCommentEntry` et al.
   - If the new entry type appears in `normalizeHistoryEntries`, decide whether to dedupe / collapse it.
3. **Writers** — anywhere that appends history needs to know about the new shape:
   - `task-store.ts` `updateTaskWithHistory` is the typical path.
   - MCP `add_note`, `change_status`, and the agent adapters in `engine/src/agents/`.
4. **Portal rendering** — [`portal/src/components/TaskModal.tsx`](../../portal/src/components/TaskModal.tsx) (history feed). Add a renderer for the new type or new field.
5. **Docs** — update the per-type table in [Reference: Ticket Schema](reference/ticket-schema.md#per-type-fields).

**Backwards compatibility note**: existing `.flux/*.md` files may not have the new field. Either:

- Make the field optional and treat missing as a default in readers, **or**
- Run a one-shot migration script. There is no migration framework today; write a node script that loads each file, mutates, and saves via `atomicWriteFile` from `task-store.ts`.

**Verify**:

- Load an old ticket without the field — no validation error.
- Write a new entry with the field — round-trips correctly.
- Run `npm test` in `engine/` — schema tests still pass.

---

## Cross-references

- [Reference: Ticket Schema](reference/ticket-schema.md)
- [Reference: MCP Tools](reference/mcp-tools.md)
- [Reference: REST API](reference/rest-api.md)
- [Reference: Realtime Channels](reference/realtime-channels.md)
- [Reference: Agent Adapter Contract](reference/agent-adapter-contract.md)
- [Architecture: Code Map](architecture/code-map.md)
