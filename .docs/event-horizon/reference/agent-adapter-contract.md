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

## Launch phases

Every session carries an optional `LaunchPhase` ([`agents/types.ts`](../../../engine/src/agents/types.ts)) — the portal or an MCP caller's stated reason a session exists, threaded through `start_session` / `POST /api/tasks/:id/cli-session/start` as `phase`. It drives `buildInitialPrompt`'s mission text (`shared.ts`), the FLUX-1214 grooming isolation deny-list, and per-phase module gating (`getActiveModules`, `modules.ts`) — never the adapter's own `start()` logic directly.

```ts
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'finalize' | 'chat' | 'fast-path';
```

- `grooming` / `implementation` / `review` / `finalize` — the standard per-status phases; each has its own mission text and, for `grooming`, is forced branchless (no isolation) since it only reads/writes ticket metadata via MCP tools.
- `chat` — the persistent ticket-chat session (not a dispatched phase session).
- `fast-path` (FLUX-1380) — one session grooms AND implements an XS/S ticket in a single sitting (`Grooming → In Progress → Ready`), structurally bypassing the plan gate (which only ever fires on a `Grooming → Todo` move). Unlike `grooming`, isolation is **forced on** server-side: an omitted `isolation` defaults to `'worktree'`, and an explicit `'branch'` request is honored (the FLUX-1018 branch⇒worktree spawn invariant isolates it anyway) — it writes code and commits like `implementation`, and the portal's fast-path launch sends no `isolation` of its own, so the route cannot rely on callers to request it. The launch route refuses `fast-path` with `400` for an `L`/`XL`-effort ticket or a ticket that is itself an epic parent (has its own subtasks); a ticket that merely has a `parentId` (a small epic member) stays eligible. If the session's own inline grooming step finds the work is bigger than XS/S, its mission has it write a full plan and `change_status → Todo` instead — re-entering the plan gate exactly as a normal groom would.

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
  claude:  { resume: true, background: true,  supervisor: true,  scatter: true, toolGating: true, structuredOutput: true,  effort: { supported: true,  flag: '--effort' },
             persistentChat: true,  selfPause: true,  partialDeltas: true,  permissionGating: true,  nativeAskBlocked: true,  spawnTimeMcpConfig: true,  imageAttachments: true,  chatEditGateEnforced: true  },
  gemini:  { resume: true, background: true,  supervisor: true,  scatter: true, toolGating: true, structuredOutput: true,  effort: { supported: false },
             persistentChat: false, selfPause: true,  partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: false, imageAttachments: false, chatEditGateEnforced: false },
  copilot: { resume: true, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false, effort: { supported: true,  flag: '--effort' },
             persistentChat: false, selfPause: true,  partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: true,  imageAttachments: false, chatEditGateEnforced: false },
};
```

The `effort` and the eight `persistentChat … chatEditGateEnforced` flags are shipped to the portal via **`GET /api/config`** (as `cliCapabilities`) so the UI gates features off capability, not `framework === 'claude'` (FLUX-901; consumed in FLUX-906).

| Flag | Meaning |
|------|---------|
| `resume` | Adapter can resume a prior session by id (Claude `--resume`, Copilot `--continue`). |
| `background` | Process can detach and survive engine restart. |
| `supervisor` | Adapter can drive sub-agents in a supervisor/worker pattern. |
| `scatter` | Adapter can run as a parallel worker in scatter-gather mode. |
| `toolGating` | Adapter respects allow/deny tool lists. |
| `structuredOutput` | Adapter emits structured stream-json the engine can parse for activity / tokens. |
| `effort` | Whether the CLI accepts an effort flag, and the literal (`{ supported: boolean; flag?: string }`). Folded in from the former per-adapter `PROVIDER_CAPABILITIES` tables, which disagreed (FLUX-900, audit A.8). |
| `persistentChat` | Chat-turn clean exit → `waiting-input` (not `completed`) so the next message resumes the same session. Claude-only; copilot/gemini go `completed` (still resumable via `resumeSessionId`, but the first turn isn't persistent). Distinct from `resume`. (FLUX-901, audit B.1) |
| `selfPause` | Agent `change_status('Require Input')` mid-turn parks the session as `waiting-input` (not `completed`) so it stays resumable and doesn't post its mid-turn question as a bogus completion comment or trip the scatter-gather barrier early. All three adapters as of FLUX-985 (copilot/gemini gained the pause branch; the resume route already accepts `waiting-input`). (FLUX-901 B.2; FLUX-985) |
| `partialDeltas` | Emits token-level assistant deltas (`--include-partial-messages` → `assistantDelta` SSE). Claude-only. (FLUX-901, B.3) |
| `permissionGating` | Supports the EH permission-prompt protocol (`gated` vs `skip`); the others spawn `--yolo`. Claude-only. (FLUX-901, B.4) |
| `nativeAskBlocked` | The CLI's native `AskUserQuestion` must be disabled (`--disallowed-tools`) — a `claude -p` print-mode limitation. Claude-only. (FLUX-901, B.5) |
| `spawnTimeMcpConfig` | Accepts a per-spawn MCP config file with phase/tag profile filtering. Claude (`--mcp-config`) and Copilot (`--additional-mcp-config`, a different flag/JSON shape — FLUX-984); gemini `false`. (FLUX-901, B.6; FLUX-984) |
| `imageAttachments` | Resolves pasted image attachments into the resumed prompt. Claude-only. (FLUX-901, B.7) |
| `chatEditGateEnforced` | The FLUX-926 ticket-chat file-edit gate (`disallowedToolsArgs`) is a REAL block, not just an advisory prompt note — neither Copilot nor Gemini exposes a `--disallowed-tools`-equivalent flag. Claude-only. Copilot/Gemini instead get `chatEditGateNote`'s best-effort instruction (`shared.ts`), wired into `buildInitialPrompt`'s `editsGated` option and `prependEditGateNote` on resume. (FLUX-1123) |

When you add a new framework, add a row here too.

> **FLUX-1390 (Claude-only, config-gated — not a static `CLI_CAPABILITIES` flag):** when board config `agents.honorScheduledWakeups` is `true`, `ScheduleWakeup` is no longer disallowed for a dispatched (non-chat) phase and is actually honored — a clean turn that called it enters a new `CliSessionStatus` value, `'scheduled'` (`wakeAt`/`wakeReason` on the record, no `endedAt`), instead of `'completed'`. The engine's own background wake ticker (`scheduled-wake.ts`) resumes it via `--resume` once `wakeAt` passes, tagging the call `{ wakeResume: true }` so the resumed reply's exit handler finalizes a clean no-further-sleep turn as `completed`/`failed` rather than the interactive `persistentChat`/`selfPause`-style `waiting-input` fallback. Off (the default) is byte-identical to FLUX-1389's unconditional block. See [Configuration](../configuration.md#honor-scheduled-wakeups).

> **Known gaps in the current adapter layer** — the three shipping adapters do not yet agree on the full surface area implied by this contract. **Resolved (FLUX-900):** the duplicated per-adapter helpers (`cleanChildEnv`, `checkBinaryInstalled`, `appendSessionOutput`/`flushSessionOutput`/`enqueueSessionWrite`, `EFFORT_LEVELS`) were lifted into [`shared.ts`](../../../engine/src/agents/shared.ts); `PROVIDER_CAPABILITIES` was folded into `CLI_CAPABILITIES.effort`; and the unified `cleanChildEnv(framework, conversationId?)` now sets `EH_CONVERSATION_ID` (+ `EH_CONVERSATION_TOKEN`) for **every** framework — so HITL picker routing works on Copilot/Gemini, not just Claude (audit A.6, was blocking). **Capability-flagged (FLUX-901):** the seven Claude-only optional behaviors (`persistentChat`/`selfPause`/`partialDeltas`/`permissionGating`/`nativeAskBlocked`/`spawnTimeMcpConfig`/`imageAttachments`) are now declared per-framework in `CLI_CAPABILITIES` and shipped to the portal via `GET /api/config`, so the UI can gate them off capability rather than `=== 'claude'` (FLUX-906 consumes them); the *behaviors* remain Claude-only (copilot/gemini genuinely lack them — the flag just makes that explicit and introspectable). **Resolved (FLUX-932, audit A.1/A.5):** `attachStdoutProcessing`'s shared *transport* skeleton (line buffering, `JSON.parse`-with-fallback, dispatch) now lives in `shared.ts`; each adapter still supplies its own per-CLI `onEvent` parser (the schemas genuinely differ) plus the shared `activityFor(map, toolName)` lookup (A.5). Also fixed: Gemini's captured session `output` was always `''` — two separate bugs (a dead `trackCumulative` flag, and the native `message`/`role:'assistant'` branch bypassing `appendSessionOutput` entirely) both accumulate into `cumulativeOutput` now, like Claude/Copilot. Locked by fixture tests in `adapter-contract.test.ts`. **Resolved (FLUX-960, audit A.2):** `buildInitialPrompt` is no longer per-adapter — one shared, capability-gated builder in `shared.ts` gives every framework the same phase-based mission text and the get_ticket-fetch body convention by default, gating only the pieces that trace to a real `CLI_CAPABILITIES` flag (`supervisor` for the chat-phase orchestration-proposals paragraph, `selfPause` for the Require-Input closing instruction). Claude's output is unchanged byte-for-byte (`diff-prompt-injection.test.ts`); `build-initial-prompt.test.ts` locks the gating. **Still open:** claude-only `--mcp-config` injection, claude-only `pausedForInput` flow, claude-only `permissionMode` honoring, claude-only image attachments. See the [Adapter Layer Audit](../architecture/adapter-layer-audit.md) (FLUX-700) for the full row-by-row inventory and the proposed disposition per row. New adapter work should land against the post-audit shape, not the current one.

## Lifecycle: `start`

`start(session, task, appendPrompt, effortOverride, workspaceRoot)` is called once when a CLI session begins. The standard implementation in all three adapters is a thin wrapper around a shared `startCliSession(...)` helper that:

1. Verifies the binary is on PATH (`checkBinaryInstalled`, shared in [`shared.ts`](../../../engine/src/agents/shared.ts)).
2. Builds the CLI command + args (provider-specific flags for permission mode, effort, model, resume). For Claude Code, `permissionArgs(session)` emits either `--permission-prompt-tool mcp__event-horizon__permission_prompt` (`permissionMode: 'gated'`) or `--dangerously-skip-permissions` (`permissionMode: 'skip'` / legacy `skipPermissions`) — see [`permission_prompt`](mcp-tools.md#permission_prompt) (FLUX-605).
3. `spawn`s the child process with a sanitized env (`cleanChildEnv` strips `NODE_OPTIONS` to avoid loader injection). For a routed session it also sets `EH_CONVERSATION_ID` (the bound ticket id / `__board__` sentinel) and `EH_CONVERSATION_TOKEN` — an HMAC of that conversationId minted from a per-process secret (FLUX-841). The `permission_prompt` / `ask_user_question` MCP tools forward the token on every HITL POST so the route can assert the request targets the session's OWN ticket; a session can't forge a token for a sibling, which closes same-shape cross-ticket transcript injection (`isSafeStreamId` only blocks path traversal, not a valid sibling ticket id).
4. Records the `pid`, `command`, `args`, `startedAt`, and writes an `agent_session` history entry to the ticket (`buildAgentSessionEntry` from [`history.ts`](../../../engine/src/history.ts)).

   **Pre-spawn failures never reach step 4 (FLUX-1156).** A throw during isolation (`ensureTicketIsolation`) or execution-root resolution (`resolveTaskExecutionRoot` / `assertIsolatedSpawnRoot`) happens in the route layer — `spawnSession` / `prepareAndLaunchSession` in [`routes/cli-session.ts`](../../../engine/src/routes/cli-session.ts) — BEFORE any adapter `start()` call, so no adapter ever gets to write the entry above. Without a substitute, the ticket's chat timeline (built from `agent_session` entries) rendered nothing for a session that never spawned, and `get_session_log` could never resolve the id. The route's `catch` blocks now build a stand-in entry directly (`buildFailedPreSpawnSessionEntry`, reusing `buildAgentSessionEntry` + the already-allocated session id) with `status: 'failed'` and `endedAt` set from birth, so a pre-spawn failure renders exactly like a post-spawn one.
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

**Execution root — fails closed (FLUX-519, FLUX-1018).** Before spawning, `startCliSession` resolves the child's `cwd` via `resolveTaskExecutionRoot(task, workspaceRoot)` and records it on `session.executionRoot`. The invariant: **a branch-bearing ticket always runs in its own git worktree, never the shared main checkout (master).** A branchless ticket resolves to `workspaceRoot` (the direct-commit flow). When a ticket *has* a branch but no live worktree holds it (dir removed / `.git` link broken / never created — even for a ticket started "branch only" via `worktree:false`), the resolver **self-heals** by recreating the worktree (`createTaskWorktree`, idempotent) and only throws if that genuinely fails — it never degrades to master, because a single-shot agent (Copilot `-p`) that never checks the branch out would then commit straight to master (the FLUX-972 incident). Each adapter also asserts a belt-and-suspenders guard after resolution: if `task.branch` is set yet execution resolved to `workspaceRoot`, it refuses to start. Read-only callers (diff/status/tests) pass `{ create: false }` to opt out of the recreation side effect.

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

For Claude Code's "resume" mode, `sendCliSessionInput` instead spawns a new `claude --resume <resumeSessionId>` process and re-attaches stream handlers.

**Resume fails closed too (FLUX-1018).** Resume reuses the `session.executionRoot` recorded at spawn. Only when it is missing (a legacy/serialized session) does it fall back to `resolveTaskExecutionRoot(...)`, and it passes **`{ create: false }`** there — a resume must never spin up a fresh worktree mid-conversation. It then refuses two ways: a branch-bearing ticket that resolved to `workspaceRoot` (no live worktree) is refused rather than resumed on master, and a recorded worktree path that has since vanished (ticket finished) is refused as before. In either case the fix is to restart the session, which recreates the worktree on the spawn path.

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
| `resumeSessionId` | The framework's native resume id (Claude: stream-json `init`/`system` frame; Copilot: the final `result` event's `sessionId` field; Gemini: `session_id`), passed back as `--resume <id>`. Renamed from `claudeSessionId` in FLUX-902 — it is the resume token for any CLI, not a Claude-only concept. **FLUX-959 fix:** Copilot previously captured a `user.message` event's `parentId` — a different id in the internal event-parent chain, not the value `copilot --resume` accepts — so every resumed Copilot turn failed. Live-verified against the installed CLI: the corrected capture (`result.sessionId`) resumes correctly across multiple turns. `session.updated`/`session.created`'s `data.sessionId`/`data.id` remains as a fallback capture path (unverified live; not observed in the captured event stream). |
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

**FLUX-1156:** a pre-spawn failure (before any adapter's `start()` runs) is the one case where an `agent_session` entry is written from OUTSIDE an adapter — `routes/cli-session.ts`'s `buildFailedPreSpawnSessionEntry` builds it directly from `buildAgentSessionEntry`, pre-populated `status: 'failed'` + `outcome` + `endedAt`, since there's no adapter-driven start/exit pair to do it. The Furnace stoker (`furnace-stoker.ts`'s `findSessionOutcome`) reads that `outcome` back off ticket history to fold the real failure reason into its park comment instead of the generic "session ended failed".

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

## Phase skill module injection (instruction-layer, FLUX-1377)

Distinct from the MCP server injection above (that's tool-layer/schemas; this is instruction-layer/prompt content — the FLUX-477 vs FLUX-261 split). Since FLUX-1377, the Claude installer no longer concatenates all 6 `.docs/skills/event-horizon-*.md` modules into `.claude/rules/event-horizon.md` — it writes a trimmed **core** (~2-4k tok: invariants + a phase-routing table) built by `buildCoreSkillDocument()` in [`skill-core.ts`](../../../engine/src/skill-core.ts). Copilot/cline (Option B, one file per module) and gemini/cursor/windsurf/generic (Option A concatenation) are unchanged — they have no engine-driven spawn-time injection path, so they still need everything installed statically.

Phase content is instead appended at spawn time by `buildInitialPrompt` (`agents/shared.ts`), which loads the matching module body synchronously via `loadSkillModuleBodySync` in [`skill-modules.ts`](../../../engine/src/skill-modules.ts) and appends it under a `## Phase Skill: <phase>` heading. Gated on all three:
- **Framework `claude` only** — copilot/gemini keep their full static install; injecting there too would double-load.
- **Phase is `grooming`, `implementation`, or `review`** — the only phases with a matching module. `release`/`mapping` stay Read-on-demand (user-invoked, not phase-spawned); `chat`/`finalize` get the core only.
- **Not a delegate or relay spawn** (`opts.patternPosition` is `'assistant'` or `'step'`) — a delegate's `phase` is derived from its persona's declared phase (`resolvePersonaPrompt`'s call sites in `cli-session.ts`'s delegate route), not a genuine phase dispatch, so injecting a module there would be a role-vs-phase mismatch. Curated delegate briefs are unaffected.

This applies uniformly whether the spawn is in the main checkout or a `.eh-worktrees/*` worktree (worktrees never had `.claude/rules/` installed at all — `task-worktree.ts` — so this is a net improvement there, not a regression) and regardless of whether a `personaId` was supplied (Furnace/gate-runner/temper's `dispatchSession` calls carry no persona; the injection point is `buildInitialPrompt`'s universal phase switch, not the persona-only `resolvePersonaPrompt`).

The MCP server's `instructions` block (folded into every client's system prompt at `initialize`, see [MCP Tools](mcp-tools.md)) and the installed core's invariants are single-sourced from `CORE_INVARIANTS` in `skill-core.ts` — edit there only, both consumers render from the same array (drift-guarded by `skill-core.test.ts`).

Context-budget visibility: `computeSkillModuleMetrics(phase)` and `computeLaunchPromptMetrics(task)` in [`context-budget-metrics.ts`](../../../engine/src/context-budget-metrics.ts) report the real installed-core size plus the injected module size per phase (the portal's Context Budget panel), replacing the old measurement that summed all 6 modules regardless of what actually loads.

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
