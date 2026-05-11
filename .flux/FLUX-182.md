---
priority: Low
effort: L
tags:
  - refactor
  - dx
assignee: unassigned
createdBy: Unknown
title: Split engine/src/index.ts into focused modules
status: Grooming
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-10T14:43:07.036Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    comment: >-
      Updated ticket body to include agent-adapter interface design agreed in
      planning discussion. Added agents/types.ts (AgentAdapter, AgentEvent,
      ProviderManifest shapes), agents/claude-code.ts, agents/index.ts registry.
      Route layer delegates to adapter with zero provider-specific leakage.
      ProviderManifest carries configSchema and capabilities for future settings
      UI and feature gating.
    id: c-1778463100918-1
    date: '2026-05-11T01:31:40.922Z'
  - type: activity
    user: Agent
    date: '2026-05-11T01:31:40.922Z'
    comment: Updated description.
---
## Goal

Split `engine/src/index.ts` (2551 lines) into focused modules, introduce an agent-adapter interface so all coding-agent integration is modular and provider-agnostic, and extract `processCliOutput()` as the first concrete implementation behind that interface.

## Context

Highest-priority follow-on from FLUX-172. The monolith contains every concern: Express setup, middleware, file I/O helpers, history utilities, asset helpers, docs helpers, CLI session management, and all ~25 route handlers. This ticket also establishes the extensibility seam so future agents (Aider, Cursor, etc.) can be added without touching the engine core.

## Module Structure

```
engine/src/
  index.ts                  ← app setup + server start only (~80 lines)
  middleware.ts              ← requireWorkspace, cors, json setup
  workspace.ts               ← workspaceRoot, activateWorkspace, settings I/O
  config.ts                  ← loadConfig, saveConfig, configCache, autoRegisterUnknownTags
  history.ts                 ← buildCommentEntry, buildActivityEntry, normalizeHistoryEntries,
                                summarizeFieldChanges, hasAppendedStatusChange, ensureCreationActivity
  file-utils.ts              ← asset path helpers, doc path helpers, image/extension utils
  agents/
    types.ts                 ← AgentAdapter interface, AgentEvent union, ProviderManifest shape
    claude-code.ts           ← ClaudeCodeAdapter: implements AgentAdapter for Claude Code CLI
    index.ts                 ← registry: maps config.agentType string to adapter instance
  routes/tasks.ts            ← GET/POST/PUT/DELETE /api/tasks
  routes/cli-session.ts      ← start, input, stop routes (calls adapter, not CLI directly)
  routes/docs.ts             ← /api/docs routes
  routes/config.ts           ← /api/config routes
  routes/workspace.ts        ← /api/workspace, /api/health, /api/path-setup
  routes/assets.ts           ← /api/assets, /api/tasks/:id/assets
  routes/skill.ts            ← /api/skill/status, /api/skill/install
  routes/stats.ts            ← /api/stats/tokens
```

## Agent Adapter Interface (`agents/types.ts`)

```ts
export interface AgentEvent {
  type: ‘assistant_text’ | ‘tool_use’ | ‘permission_request’ | ‘token_usage’ | ‘done’ | ‘error’;
  payload: unknown;
}

export interface AgentAdapter {
  start(task: Task, prompt: string, options: StartOptions): Promise<AgentProcess>;
  sendInput(proc: AgentProcess, text: string): Promise<void>;
  stop(proc: AgentProcess): Promise<void>;
  parseOutput(chunk: string, session: CliSessionRecord): AgentEvent[];
}

export interface ProviderManifest {
  id: string;
  displayName: string;
  configSchema: Record<string, FieldSchema>;  // rendered by settings UI dynamically
  costModel: { inputPerMToken: number; outputPerMToken: number; currency: ‘usd’ };
  capabilities: {
    compacting: boolean;
    effortLevels: string[];   // empty array = not supported
    memoryFiles: boolean;
  };
}

export interface AgentProcess {
  proc: ChildProcess;
  sessionId: string;
  taskId: string;
}
```

**Routing is a registry lookup only** — `agents/index.ts` exports `function getAdapter(agentType: string): AgentAdapter` backed by a static map. No conditionals beyond the map lookup.

**Provider-specific features** (compacting, memory) are accessed via the `capabilities` field on the manifest — the caller checks `manifest.capabilities.compacting` before offering the control. They do not leak into the `AgentAdapter` interface itself.

## Key Extractions

1. **`parseOutput()` on `ClaudeCodeAdapter`** — moves the ~80-line JSON event-parsing, pending-text, token accumulation, and permission-block detection from the duplicated start/input routes into the adapter. Single source of truth.
2. **`buildInitialPrompt(task, config, appendPrompt)`** — the 20-line prompt-building block inside the start route, moved to `claude-code.ts`. Makes the route handler skinny.
3. **`routes/cli-session.ts`** calls `getAdapter(config.agentType)` and delegates — zero Claude-specific code in the route.

## Constraints

- No behaviour changes — structural refactor only
- `ClaudeCodeAdapter` is the only adapter implemented in this ticket; the interface exists to support future adapters
- Do not abstract what cannot be validated with one concrete case — keep the interface minimal
- `npm run dev:no-watch` must be used during implementation (engine source edits kill the active session under tsx watch)
- All imports must resolve; no circular dependencies

## Validation

- Engine starts without errors
- All ticket CRUD operations work via the API
- CLI session start/input/stop cycle works end-to-end
- No duplicate stdout-processing logic remains
- `agents/index.ts` registry resolves `claude-code` to `ClaudeCodeAdapter`
- No Claude-specific code in `routes/cli-session.ts`
