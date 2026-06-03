---
title: Documentation Index
order: 0
---
# Documentation Index

This index routes by **subsystem**. For each subsystem you get the code entry points, the authoritative reference doc, and any related ADRs. Read only what matches the ticket's domain.

> **Reference docs (`reference/`)** describe current behavior and are kept in sync with code. **Decision docs (`decisions/`)** are historical reasoning — skip them for ticket work unless you are reopening the decision.

## Subsystem map

| Subsystem | Code entry points | Reference | Decisions |
|---|---|---|---|
| **Engine bootstrap / HTTP server** | [`engine/src/index.ts`](../../engine/src/index.ts), [`engine/src/workspace.ts`](../../engine/src/workspace.ts) | [Architecture Overview](architecture/overview.md), [Code Map](architecture/code-map.md) | — |
| **Ticket store + persistence** | [`engine/src/task-store.ts`](../../engine/src/task-store.ts), [`engine/src/schema.ts`](../../engine/src/schema.ts), [`engine/src/history.ts`](../../engine/src/history.ts) | [Ticket Model](architecture/ticket-model.md), planned `reference/ticket-schema.md` (FLUX-357) | — |
| **REST API (portal-facing)** | [`engine/src/routes/`](../../engine/src/routes) | [REST API](reference/rest-api.md) | [ADR 0001 — Storage Modes](decisions/0001-storage-modes.md) (storage-related routes) |
| **MCP server (agent-facing)** | [`engine/src/mcp-server.ts`](../../engine/src/mcp-server.ts) | [MCP Server](mcp-server.md), [MCP Tools](reference/mcp-tools.md) | — |
| **Agent integrations** | [`engine/src/agents/`](../../engine/src/agents), [`engine/src/session-store.ts`](../../engine/src/session-store.ts) | [Agent Integrations](agent-integrations.md), planned `reference/agent-adapter-contract.md` (FLUX-358) | [ADR 0002 — Multi-Agent CLI](decisions/0002-multi-agent-cli.md) |
| **Realtime / live updates** | [`engine/src/events.ts`](../../engine/src/events.ts), watchers in [`task-store.ts`](../../engine/src/task-store.ts), [`portal/src/AppContext.tsx`](../../portal/src/AppContext.tsx) | Planned `reference/realtime-channels.md` (FLUX-357) | — |
| **Sync / orphan-branch storage** | [`engine/src/sync-watcher.ts`](../../engine/src/sync-watcher.ts), [`engine/src/storage-sync.ts`](../../engine/src/storage-sync.ts), [`engine/src/branch-manager.ts`](../../engine/src/branch-manager.ts) | [Architecture Overview](architecture/overview.md) (storage section) | [ADR 0001 — Storage Modes](decisions/0001-storage-modes.md) |
| **Workflow installer / skills** | [`engine/src/workflow-installer.ts`](../../engine/src/workflow-installer.ts), [`engine/src/skill-installer.ts`](../../engine/src/skill-installer.ts) | [Workflow Install](workflow/workflow-install.md) | — |
| **Ticket lifecycle (process)** | — | [Ticket Lifecycle](workflow/ticket-lifecycle.md), [Ticket Interactions](workflow/ticket-interactions.md) | — |
| **Portal — board / backlog / cards** | [`portal/src/components/Board.tsx`](../../portal/src/components/Board.tsx), [`Column.tsx`](../../portal/src/components/Column.tsx), [`TaskCard.tsx`](../../portal/src/components/TaskCard.tsx), [`BacklogScreen.tsx`](../../portal/src/components/BacklogScreen.tsx) | [Ticket Interactions](workflow/ticket-interactions.md), [Code Map](architecture/code-map.md) | — |
| **Portal — ticket modal** | [`portal/src/components/TaskModal.tsx`](../../portal/src/components/TaskModal.tsx), [`portal/src/components/task-modal/`](../../portal/src/components/task-modal) | [Ticket Interactions](workflow/ticket-interactions.md) | — |
| **Portal — docs wiki** | [`portal/src/components/DocsScreen.tsx`](../../portal/src/components/DocsScreen.tsx), [`DocsSidebar.tsx`](../../portal/src/components/DocsSidebar.tsx) | [Docs Workspace](architecture/docs-workspace.md) | — |
| **Portal — settings** | [`portal/src/components/Settings.tsx`](../../portal/src/components/Settings.tsx), [`portal/src/components/settings/`](../../portal/src/components/settings) | [Configuration](configuration.md) | — |
| **App state / context** | [`portal/src/AppContext.tsx`](../../portal/src/AppContext.tsx), [`portal/src/api.ts`](../../portal/src/api.ts) | [Architecture Overview](architecture/overview.md), [Code Map](architecture/code-map.md) | — |
| **Configuration / global settings** | [`engine/src/config.ts`](../../engine/src/config.ts), [`engine/src/global-settings.ts`](../../engine/src/global-settings.ts) | [Configuration](configuration.md) | — |
| **Cost / model pricing** | [`engine/src/agents/`](../../engine/src/agents) (token accounting) | [Model Pricing](model-pricing.md) | — |
| **Installation / packaging** | [`engine/scripts/`](../../engine/scripts) | [Installation](installation.md) | — |
| **Development setup** | top-level `package.json`, workspace scripts | [Development](development.md) | — |
| **Troubleshooting** | — | [Windows Agent Spawn](troubleshooting/windows-agent-spawn.md) | — |
| **Project framing** | — | [Project Overview](project-overview.md) | — |

## Planned reference pages

Some pages above are referenced as *planned* — they are being written in tickets FLUX-356 through FLUX-360. Until then, use the listed code entry points as the source of truth.

## Recipes

A `recipes.md` page (FLUX-359) will collect "to do X, touch these files" entries for the most common change shapes. When it lands, link to it here first.
