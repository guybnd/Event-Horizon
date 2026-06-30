---
title: Agent Adapter Contract
order: 5
---
# Agent Adapter Contract

How the engine talks to CLI coding agents (Claude Code, Copilot CLI, Gemini CLI), and what you have to implement to add a new one. Source of truth: [`engine/src/agents/types.ts`](../../../engine/src/agents/types.ts), [`engine/src/agents/index.ts`](../../../engine/src/agents/index.ts), and the three existing adapters under `engine/src/agents/`.

## The interface

```ts
// engine/src/agents/types.ts
export interface AgentAdapter {
  readonly manifest: ProviderManifest;
  labelForFramework(): string;
  start(
    session: CliSessionRecord,
    task: unknown,
    appendPrompt: string,
    effortOverride: string,
    workspaceRoot: string,
  ): Promise<void>;
  sendInput(
    session: CliSessionRecord,
    message: string,
    user: string,
    workspaceRoot: string,
    opts?: SendInputOptions, // FLUX-674: optional per-turn extras (image attachments)
  ): Promise<void>;
  stop(session: CliSessionRecord): void;
}
```

`SendInputOptions` carries optional per-turn extras: `{ attachments?: ChatAttachment[] }` (FLUX-674). `attachments` are pasted-image refs the chat composer uploaded; the Claude adapter resolves each to its absolute sidecar path and appends a Read-the-image instruction to the resumed prompt (the `claude` CLI is driven via `-p`, not a stream-json content-block stdin). Adapters that don't support image input ignore it — the param is optional, so their 4-arg implementations still satisfy the interface.

Three adapters ship today: `ClaudeCodeAdapter`, `CopilotAdapter`, `GeminiAdapter`. They are registered by string id in [`agents/index.ts`](../../../engine/src/agents/index.ts):

```ts
const registry: Map<string, AgentAdapter> = new Map([
  ['claude', new ClaudeCodeAdapter()],
  ['copilot', new CopilotAdapter()],
  ['gemini', new GeminiAdapter()],
]);
```

`getAdapter('claude' | 'copilot' | 'gemini')` is the only entry point used by routes and the MCP server.

## Manifest

```ts
export interface ProviderManifest {
  id: string;
  displayName: string;
  configSchema: Record<string, FieldSchema>;
  costModel: { inputPerMToken: number; outputPerMToken: number; currency: 'usd' };
  capabilities: {
    compacting: boolean;
    effortLevels: string[];
    memoryFiles: boolean;
  };
}
```

- `id` — stable string used in URLs and storage; does not have to equal the registry key (e.g. registry key `claude`, manifest id `claude-code`).
- `displayName` — what the portal puts on launch buttons and badges.
- `configSchema` — declarative form schema for any provider-specific settings the portal should render. All three current adapters use `{}`.
- `costModel` — feeds the token-to-cost estimator (`estimateCostUSD` in [`task-store.ts`](../../../engine/src/task-store.ts)). Currency is always `usd`.
- `capabilities` — coarse feature flags consumed by the portal to enable / hide UI affordances.

## Capabilities matrix

There is a second capabilities table in [`types.ts`](../../../engine/src/agents/types.ts), keyed by `CliFramework` rather than adapter id, used by the multi-agent orchestration layer:

```ts
export const CLI_CAPABILITIES: Record<CliFramework, CliCapabilities> = {
  claude:  { resume: true, background: true,  supervisor: true,  scatter: true, toolGating: true, structuredOutput: true,  effort: { supported: true,  flag: '--effort' } },
  gemini:  { resume: true, background: true,  supervisor: true,  scatter: true, toolGating: true, structuredOutput: true,  effort: { supported: false } },
  copilot: { resume: true, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false, effort: { supported: true,  flag: '--effort' } },
};
```

| Flag | Meaning |
|------|---------|
| `resume` | Adapter can resume a prior session by id (Claude `--resume`, Copilot `--continue`). |
| `background` | Process can detach and survive engine restart. |
| `supervisor` | Adapter can drive sub-agents in a supervisor/worker pattern. |
| `scatter` | Adapter can run as a parallel worker in scatter-gather mode. |
| `toolGating` | Adapter respects allow/deny tool lists. |
| `structuredOutput` | Adapter emits structured stream-json the engine can parse for activity / tokens. |
| `effort` | Whether the CLI accepts an effort flag, and the literal (`{ supported: boolean; flag?: string }`). Folded in from the former per-adapter `PROVIDER_CAPABILITIES` tables, which disagreed (FLUX-900, audit A.8). |

When you add a new framework, add a row here too.

> **Known gaps in the current adapter layer** — the three shipping adapters do not yet agree on the full surface area implied by this contract. **Resolved (FLUX-900):** the duplicated per-adapter helpers (`cleanChildEnv`, `checkBinaryInstalled`, `appendSessionOutput`/`flushSessionOutput`/`enqueueSessionWrite`, `EFFORT_LEVELS`) were lifted into [`shared.ts`](../../../engine/src/agents/shared.ts); `PROVIDER_CAPABILITIES` was folded into `CLI_CAPABILITIES.effort`; and the unified `cleanChildEnv(framework, conversationId?)` now sets `EH_CONVERSATION_ID` (+ `EH_CONVERSATION_TOKEN`) for **every** framework — so HITL picker routing works on Copilot/Gemini, not just Claude (audit A.6, was blocking). **Still open:** claude-only `__board__` orchestrator, claude-only `--mcp-config` injection, claude-only `pausedForInput` flow, claude-only `permissionMode` honoring, claude-only image attachments, and the still-per-adapter `attachStdoutProcessing` / `buildInitialPrompt` (audit A.1/A.2 — deferred to land alongside the cross-adapter contract test net, since each parses a different stdout schema). See the [Adapter Layer Audit](../architecture/adapter-layer-audit.md) (FLUX-700) for the full row-by-row inventory and the proposed disposition per row. New adapter work should land against the post-audit shape, not the current one.

## Lifecycle: `start`

`start(session, task, appendPrompt, effortOverride, workspaceRoot)` is called once when a CLI session begins. The standard implementation in all three adapters is a thin wrapper around a shared `startCliSession(...)` helper that:

1. Verifies the binary is on PATH (`checkBinaryInstalled`, shared in [`shared.ts`](../../../engine/src/agents/shared.ts)).
2. Builds the CLI command + args (provider-specific flags for permission mode, effort, model, resume). For Claude Code, `permissionArgs(session)` emits either `--permission-prompt-tool mcp__event-horizon__permission_prompt` (`permissionMode: 'gated'`) or `--dangerously-skip-permissions` (`permissionMode: 'skip'` / legacy `skipPermissions`) — see [`permission_prompt`](mcp-tools.md#permission_prompt) (FLUX-605).
3. `spawn`s the child process with a sanitized env (`cleanChildEnv` strips `NODE_OPTIONS` to avoid loader injection). For a routed session it also sets `EH_CONVERSATION_ID` (the bound ticket id / `__board__` sentinel) and `EH_CONVERSATION_TOKEN` — an HMAC of that conversationId minted from a per-process secret (FLUX-841). The `permission_prompt` / `ask_user_question` MCP tools forward the token on every HITL POST so the route can assert the request targets the session's OWN ticket; a session can't forge a token for a sibling, which closes same-shape cross-ticket transcript injection (`isSafeStreamId` only blocks path traversal, not a valid sibling ticket id).
4. Records the `pid`, `command`, `args`, `startedAt`, and writes an `agent_session` history entry to the ticket (`buildAgentSessionEntry` from [`history.ts`](../../../engine/src/history.ts)).
5. Streams stdout and stderr:
   - Buffers output via `appendSessionOutput` / `flushSessionOutput`.
   - Parses stream-json frames (Claude/Copilot) into:
     - **assistant text** → broadcast as `progress` SSE and appended to `agent_session.progress[]` in memory (not flushed to disk during the session — writes mid-session would make the agent see its own file changing).
     - **tool use** → maps the tool name through `TOOL_ACTIVITY_MAP` and broadcasts `activity` SSE (`Bash` → `Running command`, `Edit`/`Write` → `Editing`, …).
     - **token usage** → updates `session.inputTokens` / `outputTokens` / cache counters and the cost estimate.
6. On exit:
   - Determines final status: `completed` / `failed` / `cancelled` based on exit code and `requestedStop`.
   - Calls `closeAgentSession` to finalize the `agent_session` history entry (sets `endedAt`, `status`, flushes accumulated progress to disk).
   - Fires `taskUpdated` SSE.
   - On `completed`: runs `checkFrameworkHealth` and `checkSkillStaleness` (notification side effects).
   - If the session has a `groupId`: calls `notifyGroupSessionTerminal(taskId, groupId)` (session-store fan-in barrier). This lets a deferred scatter-gather combiner spawn once every worker in the group has reached a terminal state. Adapters must call this for orchestration sequencing to work.

`task` is typed `unknown` because the adapter only reads its `id` and (optionally) `title`. The engine passes the live cache entry.

`appendPrompt` is appended to the system prompt — currently used by orchestration patterns to inject role / coordination instructions.

`effortOverride` is one of `EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']` for adapters whose CLI accepts `--effort`. Adapters without effort support ignore it.

## Lifecycle: `sendInput`

Called when the user types into an active session. All three adapters forward to a shared `sendCliSessionInput(...)` that:

1. Verifies binary still installed.
2. Sets `session.lastInputAt`, `session.status = 'running'`.
3. Writes an `agent_message` history entry attributed to `user`.
4. Writes the message to the child process stdin.
5. Broadcasts `taskUpdated`.

For Claude Code's "resume" mode, `sendCliSessionInput` instead spawns a new `claude --resume <claudeSessionId>` process and re-attaches stream handlers.

**Image attachments (FLUX-674).** When `opts.attachments` is present, `sendCliSessionInput` resolves each ref to its absolute path under the per-ticket asset sidecar (`resolveAttachmentAbsPaths`, guarded to stay inside the assets root), records the refs on the transcript user turn (so the bubble re-renders on reload), notes the filenames in the history comment, and appends `attachmentReadInstruction(...)` — a "view these with the Read tool" block listing the absolute paths — to the `-p` prompt. The opening turn takes the same treatment via the `/cli-session/start` route. **FLUX-676:** the board orchestrator chat (`startBoardSession` / `sendBoardInput`, outside the `AgentAdapter` interface) accepts the same `SendInputOptions` and reuses `resolveAttachmentAbsPaths` + `attachmentReadInstruction`; its images live in the `assets/__board__/` sidecar rather than a per-ticket one, and it records the refs on the `__board__` transcript turn (no ticket history).

## Lifecycle: `stop`

The canonical implementation is one line:

```ts
stop(session: CliSessionRecord): void {
  session.proc?.kill('SIGTERM');
}
```

The cleanup work (history finalization, status update, SSE broadcast) happens in the `exit` handler installed by `start`, so `stop` only has to deliver the signal.

## Session record

`CliSessionRecord` (extends `CliSessionSummary`) is the in-memory state the engine carries for an active session. Adapters mutate it freely; routes and the MCP server serialize only the `CliSessionSummary` subset out to clients.

Key fields adapters touch:

| Field | Set by adapter when |
|-------|---------------------|
| `proc` | spawn |
| `pid` | spawn |
| `command` / `args` | spawn (for display) |
| `status` | every state transition |
| `lastOutputAt` / `lastInputAt` | each I/O event |
| `currentActivity` | early on a partial `content_block_start` (tool name known before its input streams, FLUX-927), then on the complete tool-use frame |
| `outputBuffer` / `liveOutputBuffer` | stream parsing |
| `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` | each usage frame |
| `costUSD` / `costIsEstimated` | each usage frame (via `estimateCostUSD`) |
| `claudeSessionId` | Claude-specific: parsed from stream-json `init` frame, used for resume |
| `sessionHistoryEntry` | start (the `AgentSessionEntry` being mutated) |
| `requestedStop` | user-initiated stop |

## SSE events the adapter emits

Through `broadcastEvent` (see [Realtime Channels](realtime-channels.md)):

| Event | When | Payload |
|-------|------|---------|
| `progress` | each flushed assistant-text chunk | `{ taskId, sessionId, timestamp, message }` |
| `activity` | each tool use | `{ taskId, activity }` where `activity` is the mapped string |
| `activity` (`null`) | tool-use completes | `{ taskId, activity: null }` clears the indicator |
| `taskUpdated` | spawn, send, exit | `{ id }` |

The portal subscribes to `progress` and `activity`; it picks up state changes from the next poll of `/api/tasks`.

## History entries the adapter writes

Via the helpers in [`history.ts`](../../../engine/src/history.ts):

| Helper | Entry type | When |
|--------|-----------|------|
| `buildAgentSessionEntry` | `agent_session` | session start. Accepts an optional group descriptor (`{ groupId, role, pattern }`) so orchestrated sessions stamp their run id, role, and execution pattern onto the history entry. |
| `appendSessionProgress` | (mutates the `agent_session.progress[]`) | each flushed chunk (in-memory until session end) |
| `closeAgentSession` | (mutates the `agent_session`) | session exit — flushes progress, sets `endedAt` and final `status` |
| `buildAgentMessageEntry` | `agent_message` | each user input sent into the session |
| `buildActivityEntry` | `activity` | engine-level events (rarely from the adapter itself) |
| `buildCommentEntry` | `comment` | not used by adapters today; reserved for explicit agent comments |

Always write through `updateTaskWithHistory` (atomic) — never construct frontmatter and write the file directly.

## Adding a new framework

1. Add the framework to `CliFramework` and the `CLI_CAPABILITIES` table in [`types.ts`](../../../engine/src/agents/types.ts).
2. Implement `AgentAdapter` in `engine/src/agents/<framework>.ts`. The cheapest path:
   - Reuse the shared spawn / stream-parse code by following the structure of [`claude-code.ts`](../../../engine/src/agents/claude-code.ts).
   - If the CLI does not emit stream-json, you'll need a custom parser; at minimum derive `assistant_text` (for `progress` SSE) and `tool_use` (for `activity` SSE).
3. Register it in [`agents/index.ts`](../../../engine/src/agents/index.ts):
   ```ts
   ['myagent', new MyAgentAdapter()],
   ```
4. Add an entry to the portal's `FrameworkSelector.tsx` so users can pick it.
5. Update [`docs/event-horizon/agent-integrations.md`](../agent-integrations.md) and this page.
6. Run an end-to-end session against a real ticket and verify:
   - `agent_session` entry created on start.
   - `progress` and `activity` SSE events visible in the portal.
   - Token counters incrementing.
   - On exit, `agent_session.status` finalizes correctly and progress is flushed to the ticket file.

## MCP server injection at spawn (per-phase profiles)

The Claude adapter injects MCP servers into the spawned agent via `--mcp-config`, built by `buildSpawnMcpConfigArgs(phase, tags)` in [`claude-code.ts`](../../../engine/src/agents/claude-code.ts):

- **Default (no `mcpServerPhases` config):** emits `--mcp-config` with the active **module** servers only (phase/tag-gated via each module's `phases`/`requireTags`). This *merges* with the workspace `.mcp.json` + user/global servers — so `.mcp.json` servers always load.
- **Opt-in per-phase profiles:** set the board-config field `mcpServerPhases: { [serverId]: string[] }`. A server listed there loads **only** for the named phases. When this field is non-empty, the engine takes ownership of the full set — workspace `.mcp.json` servers ∪ module servers — drops any server whose phases exclude the current phase, and spawns with **`--strict-mcp-config`** so Claude Code uses *only* this set (ignoring `.mcp.json`/user/global). `event-horizon` is never filtered (agents need ticket tools).

Example: `"mcpServerPhases": { "basic-memory": ["implementation"] }` keeps basic-memory's ~8k of tool schemas out of grooming/review sessions. The pure filter is `filterMcpServersByPhase()` (exported, unit-tested). Measure the effect with the `GET /api/tasks/debug/mcp-schemas` probe (FLUX-488).

> The `event-horizon` server entry itself is no longer a spawned stdio process: it is the engine's own in-process Streamable-HTTP mount at `http://127.0.0.1:<engine-port>/mcp` (`type: "http"`), so spawned agents — main checkout or `.eh-worktrees/*` worktree — all reach the same canonical task store over loopback. See [MCP Tools → How tools are exposed](mcp-tools.md#how-tools-are-exposed) (FLUX-645).

> Caveat: in strict mode the engine is the single source of MCP servers for that spawn — any server only present in user/global config (not `.mcp.json` or modules) is dropped. Keep profiles minimal and verify with the probe.

## Error handling

- `checkBinaryInstalled` throws a user-facing error if the CLI is missing. Routes surface it as a 400 with the message.
- Stream-parse errors are swallowed and logged — a malformed frame from the CLI should never crash the engine.
- `cleanChildEnv` (in [`shared.ts`](../../../engine/src/agents/shared.ts)) is mandatory: any `NODE_OPTIONS` inherited from the parent (typical when the engine itself is launched from VS Code) will break the child agent's loader — it is **removed** entirely (not blanked to `''`, which some pkg-built CLIs still parse).
- Windows ConPTY noise from `AttachConsole failed` is filtered in `appendSessionOutput`.

## Cross-references

- [Architecture: Agent Integrations](../agent-integrations.md) — higher-level narrative.
- [Reference: Realtime Channels](realtime-channels.md) — where `progress` / `activity` events go.
- [Reference: Ticket Schema](ticket-schema.md) — `agent_session` history entry shape.
- [Reference: MCP Tools](mcp-tools.md) — the surface the agent uses to read and mutate tickets.
