---
title: Adapter Layer Audit — CLI-hardcoded surfaces
order: 9
---
# Adapter Layer Audit — CLI-hardcoded surfaces

> Phase 0 deliverable for **FLUX-700**. Pure inventory + dispositions. No implementation here; each row becomes its own follow-up ticket.
> Pair this with the [Agent Adapter Contract](../reference/agent-adapter-contract.md) (the canonical interface) and the [Code Map](code-map.md) (where things live).

## How to read this doc

The agent layer was built on Claude Code, then opened up to Copilot CLI and Gemini CLI. The runtime adapter registry (`engine/src/agents/index.ts`) knows three frameworks; nothing else does — the routes, the MCP server, the portal, and the skill-installer each have their own framework awareness, and they disagree.

This doc enumerates every place where `claude` is special-cased, every helper that was duplicated when copilot/gemini were added, and every contract hole where claude has a capability the others do not. For each:

| field | meaning |
| --- | --- |
| **Location** | `file.ts:NNN` — current code, line-anchored. |
| **What it does today** | One sentence. |
| **Why it's claude-hardcoded** | Legacy from claude-only era · claude is the only CLI with this capability · abstraction never built · silent coupling. |
| **Severity** | `blocking` — a non-claude framework cannot work correctly without this fixed. `leaky` — works, but the abstraction is wrong. `cosmetic` — naming/comments only. |
| **Disposition** | `promote-to-AgentAdapter` · `new-BoardAdapter-interface` · `capability-flag-in-CLI_CAPABILITIES` · `rename-only` · `extract-shared-helper` · `delete-as-dead` · `leave-with-justification`. |

The dispositions are deliberately small in number — the follow-up implementation tickets will batch by disposition, not by row.

---

## A. The three adapter files — re-declared scaffolding

Phase 1 (a separate ticket) lifts these into `engine/src/agents/shared.ts`.

> **Resolution status (FLUX-900, epic FLUX-851).** **Landed:** A.3 (`appendSessionOutput`/`flushSessionOutput`/`enqueueSessionWrite`), A.4 (`EFFORT_LEVELS`), A.6 (`cleanChildEnv` — the blocking fix; now sets `EH_CONVERSATION_ID`/`EH_CONVERSATION_TOKEN` for every framework), A.7 (`checkBinaryInstalled`), A.8 (`PROVIDER_CAPABILITIES` → `CLI_CAPABILITIES.effort`), A.9 (`cliLabelForFramework` deleted) — all in `shared.ts`. **Landed (FLUX-932, after the FLUX-903 test net):** A.1 (`attachStdoutProcessing` — shared transport skeleton, per-adapter `onEvent` parser preserved verbatim) and A.5 (`TOOL_ACTIVITY_MAP` lookup → shared `activityFor`). **Still deferred:** A.2 (`buildInitialPrompt`) was carved out to **FLUX-960** as a capability-gated-parity redesign, not a straight extraction — the divergence turned out to be structural (Claude phase-based, Copilot/Gemini status-based), not just the body-echo toggle this doc assumed. **Corrections found during A.3 extraction (the "word-for-word identical" claim below was wrong in two places, both now preserved exactly via a parameter, not normalized):** (1) `flushSessionOutput` — Claude pushed progress with no `type` (renders compact) while Copilot/Gemini pushed `type:'text'` (renders as a "Narration" block); (2) `appendSessionOutput` — Gemini never accumulated `session.cumulativeOutput`, so a Gemini session's captured `output` was always `''` (**fixed in FLUX-932** — and adversarial review while writing FLUX-932's fixture tests found the first fix only covered the Claude-schema-fallback branch; Gemini's *native* `message`/`role:'assistant'` branch — the schema a real Gemini CLI session actually emits — separately bypassed `appendSessionOutput` by writing straight to `outputBuffer`; both paths now accumulate). Also: `cleanChildEnv` now **removes** `NODE_OPTIONS` rather than blanking it to `''` (Gemini's documented pkg-binary-safe behavior, harmless for Claude/Copilot).

### A.1 `attachStdoutProcessing`

- **Location** — [`claude-code.ts:415`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:195`](../../../engine/src/agents/copilot.ts), [`gemini.ts:212`](../../../engine/src/agents/gemini.ts).
- **What it does today** — Each adapter has its own ~150-line function that wires the spawned CLI's stdout to: (a) the per-ticket transcript JSONL, (b) `appendSessionOutput` for the chat history, (c) tool-activity progress strings, (d) usage / cost capture, (e) `pendingAssistantText` buffering. Each parses a different JSONL schema.
- **Why** — Each CLI emits a different JSONL stream-format (`assistant.content[]` blocks for claude, `assistant.message_delta` deltas for copilot, `message` / `tool_use` events for gemini). Gemini's parser even retains a fallback that accepts Claude's schema. The transport-side (write into the same `session` record) is identical; only the event-type table differs.
- **Severity** — `leaky`.
- **Disposition** — `extract-shared-helper`. One `attachStdoutProcessing(session, proc, { onEvent })`, with a per-adapter event-handler table.

### A.2 `buildInitialPrompt`

- **Location** — [`claude-code.ts:225`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:146`](../../../engine/src/agents/copilot.ts), [`gemini.ts:149`](../../../engine/src/agents/gemini.ts).
- **What it does today** — Builds the system prompt that gets passed via `-p`. Composes the mission text, the EH header, recent activity, the MCP note, the persona overlay, and optionally the `diffBlock` (FLUX-557 review surface).
- **Why** — Forked when each adapter was added. **Silent divergence**: per FLUX-498 the claude variant deliberately stopped echoing `task.body` (the agent reads it via `get_ticket`); copilot and gemini still echo it inline. Prompt size therefore differs by adapter and is not tracked.
- **Severity** — `leaky-bordering-blocking`. Also see C.14 — `context-budget-metrics.ts` imports only the claude version.
- **Disposition** — `extract-shared-helper`.

### A.3 `appendSessionOutput` / `flushSessionOutput` / `enqueueSessionWrite`

- **Location** — [`claude-code.ts:65 / 95 / 87`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:65 / 95 / 87`](../../../engine/src/agents/copilot.ts), [`gemini.ts:69 / 98 / 90`](../../../engine/src/agents/gemini.ts).
- **What it does today** — The serialized-writer chain that fans stdout chunks into the per-session output buffer and SSE events. Word-for-word identical across the three adapters.
- **Why** — Pure duplication. Forked when each adapter was added.
- **Severity** — `leaky`.
- **Disposition** — `extract-shared-helper`.

### A.4 `EFFORT_LEVELS`

- **Location** — [`claude-code.ts:170`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:40`](../../../engine/src/agents/copilot.ts), [`gemini.ts:43`](../../../engine/src/agents/gemini.ts).
- **What it does today** — `['low','medium','high','xhigh','max']` constant; identical in all three. Surfaced through each adapter's manifest as `effortLevels`.
- **Why** — Re-declared on each fork.
- **Severity** — `leaky`.
- **Disposition** — `extract-shared-helper`.

### A.5 `TOOL_ACTIVITY_MAP`

- **Location** — [`claude-code.ts:182`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:51`](../../../engine/src/agents/copilot.ts), [`gemini.ts:58`](../../../engine/src/agents/gemini.ts).
- **What it does today** — Maps a CLI-specific tool name (e.g. `Read`, `Bash`, `Edit` for claude; the Copilot CLI's tool ids; the Gemini CLI's tool ids) to a human-readable "Working on X" activity string.
- **Why** — The keys *must* differ per adapter (different CLIs have different tool catalogs), but the **lookup interface** (`activityFor(toolName) → string`, fall back to `'Working'`) is shared.
- **Severity** — `leaky`.
- **Disposition** — `extract-shared-helper` (the lookup); keep the per-adapter map next to its parser.

### A.6 `cleanChildEnv` — the blocking asymmetry

- **Location** — [`claude-code.ts:33`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:27`](../../../engine/src/agents/copilot.ts), [`gemini.ts:28`](../../../engine/src/agents/gemini.ts).
- **What it does today** — Cleans the parent process's env before spawning the CLI: strips `npm_*`, `NODE_*`, and `EH_*` keys; injects `EVENT_HORIZON_FRAMEWORK = '<self>'`.
- **Why** — All three were forked when the adapters split. The drift: **only claude's signature accepts `conversationId` and sets `EH_CONVERSATION_ID = conversationId`** (`claude-code.ts:47`). Copilot's and gemini's are no-arg and never set it.
- **Severity** — **`blocking`**.
- **Downstream impact** — `EH_CONVERSATION_ID` powers the MCP picker routing for `permission_prompt`, `ask_user_question`, and `propose_board_rebase` (see C.9). From a copilot or gemini session, the env var is `undefined`, the MCP handler sends `conversationId: null`, and the portal cannot show the picker on the originating chat — it falls into the global overlay. The feature visibly degrades on non-claude adapters.
- **Disposition** — `extract-shared-helper`. The unified function accepts `conversationId?` and sets `EH_CONVERSATION_ID` from every adapter.

### A.7 `checkBinaryInstalled`

- **Location** — [`claude-code.ts:24`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:18`](../../../engine/src/agents/copilot.ts), [`gemini.ts:18`](../../../engine/src/agents/gemini.ts).
- **What it does today** — Pre-flight existence check for the CLI binary on PATH, using `where` on Windows and `command -v` elsewhere. Identical.
- **Why** — Forked.
- **Severity** — `leaky`.
- **Disposition** — `extract-shared-helper`.

### A.8 `PROVIDER_CAPABILITIES`

- **Location** — [`claude-code.ts:173`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:43`](../../../engine/src/agents/copilot.ts), [`gemini.ts:46`](../../../engine/src/agents/gemini.ts).
- **What it does today** — A per-adapter table that records whether the CLI supports an effort flag and what the flag literal is (e.g. `--reasoning`).
- **Why** — Effort support is per-CLI, so this *needs* to be per-adapter — but it should live as a field in [`CLI_CAPABILITIES`](../../../engine/src/agents/types.ts) (D.2), not as a separate parallel table that disagrees with it.
- **Severity** — `leaky`.
- **Disposition** — `extract-shared-helper` — fold into `CLI_CAPABILITIES`, delete the per-adapter tables.

### A.9 `cliLabelForFramework`

- **Location** — [`claude-code.ts:178`](../../../engine/src/agents/claude-code.ts) (`'claude' | 'copilot'`), [`copilot.ts:47`](../../../engine/src/agents/copilot.ts) (no arg), [`gemini.ts:52`](../../../engine/src/agents/gemini.ts) (`'claude' | 'copilot' | 'gemini'`).
- **What it does today** — Returns the display label for a framework string. Three forks; the claude one's signature can't even label `'gemini'` (it was added before the gemini adapter existed and never widened).
- **Why** — Forked, never reconciled.
- **Severity** — `cosmetic`.
- **Disposition** — `delete-as-dead`. The display label is on the manifest (`getAdapter(framework).manifest.displayName`); use that.

---

## B. Adapter contract holes — surfaces only claude has today

These are features that exist for claude but not for the other adapters. They are the most product-visible items in the audit because every one represents a UX regression when the user switches frameworks.

> **Capability-flagged (FLUX-901).** B.1–B.7 are now declared per-framework on `CLI_CAPABILITIES` (`persistentChat`, `selfPause`, `partialDeltas`, `permissionGating`, `nativeAskBlocked`, `spawnTimeMcpConfig`, `imageAttachments`) and shipped to the portal via `GET /api/config`, so the UI gates them off capability instead of `=== 'claude'` (FLUX-906 consumes them). The *behaviors* remain Claude-only and stay encapsulated in `claude-code.ts` — the adapters already provide per-framework dispatch, so the audit's "lift into an `AgentAdapter` lifecycle hook" was not needed (verified: copilot/gemini have their own `startCliSession`; claude-code.ts's `framework === 'claude'` checks are defensive/always-true). Note `persistentChat`/`selfPause` are distinct from `resume`: copilot/gemini can `--resume` (the `resume` flag) but their first chat turn exits `completed`, not the persistent `waiting-input`.

### B.1 Persistent chat (`phase === 'chat'` → `waiting-input`)

- **Location** — [`claude-code.ts:783-797`](../../../engine/src/agents/claude-code.ts) (the spawn-exit branch in `startCliSession`).
- **What it does today** — When the spawned claude exits cleanly on the chat surface, the session transitions to `'waiting-input'` (not `'completed'`) so the next user message resumes the existing conversation rather than spawning a fresh, amnesiac session.
- **Why** — Implemented on claude only because `--resume` was claude's first-class capability when the chat surface shipped.
- **Severity** — **`blocking`**. The chat surface degrades to one-shot interactions on copilot and gemini.
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`persistentChat: boolean`) + a lifecycle hook in `AgentAdapter` that the route layer drives once for all adapters.

### B.2 `pausedForInput` — agent self-pauses on `Require Input`

- **Location** — [`claude-code.ts:776, 826, 1047, 1174`](../../../engine/src/agents/claude-code.ts); field at [`types.ts:118`](../../../engine/src/agents/types.ts).
- **What it does today** — When the agent calls `change_status('Require Input')` mid-turn, the MCP handler sets `session.pausedForInput = true`; on CLI exit, the claude adapter keeps the session resumable instead of closing it (so the human can answer and the same agent picks up).
- **Why** — Implemented on claude only. Copilot/gemini have the field but only read it on `exit` to skip the parked-flag side effect.
- **Severity** — **`blocking`** when an orchestration step uses `Require Input` mid-turn.
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`selfPause: boolean`) + lifecycle hook; current per-adapter exit code becomes one place.

### B.3 `assistantDelta` SSE — token-level streaming

- **Location** — [`claude-code.ts:625`](../../../engine/src/agents/claude-code.ts) (`--include-partial-messages` flag), [`claude-code.ts:441-458`](../../../engine/src/agents/claude-code.ts) (parser branch), [`portal/src/AppContext.tsx:787`](../../../portal/src/AppContext.tsx) (global SSE subscriber).
- **What it does today** — Claude emits partial assistant messages; the adapter forwards them as `assistantDelta` SSE events; the portal renders them as live token streams.
- **Why** — Only claude's CLI supports `--include-partial-messages`. The copilot and gemini adapters don't emit `assistantDelta`; the global portal subscriber is a no-op for them.
- **Severity** — `leaky`. (Not user-blocking — they still see the final message — but the UX is visibly different.)
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`partialDeltas: boolean`); SSE channel already adapter-agnostic.

### B.4 `permissionMode` — gated vs skip

- **Location** — [`claude-code.ts:585-590`](../../../engine/src/agents/claude-code.ts) (`permissionArgs(session)`), field at [`types.ts:130`](../../../engine/src/agents/types.ts), config default at [`config.ts:90-95`](../../../engine/src/config.ts).
- **What it does today** — Per FLUX-605, the user picks `gated` (route destructive ops through the EH `permission_prompt` MCP tool via `--permission-prompt-tool`) or `skip` (`--dangerously-skip-permissions`). The default is `'gated'` for the board and `'skip'` for per-ticket sessions.
- **Why** — Claude is the only CLI that ships a permission-prompt protocol. Copilot uses `--yolo` unconditionally; gemini uses `--yolo --skip-trust` unconditionally.
- **Severity** — `blocking-for-feature-parity`. The portal still shows the picker and the routes still propagate the value for copilot/gemini sessions where it has no effect.
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`permissionGating: boolean`); portal hides the picker when the active adapter lacks it.

### B.5 `--disallowed-tools AskUserQuestion` + the MCP fallback

- **Location** — [`claude-code.ts:597`](../../../engine/src/agents/claude-code.ts) (`DISALLOW_NATIVE_ASK`), [`mcp-server.ts:1267+`](../../../engine/src/mcp-server.ts) (`ask_user_question` tool registration).
- **What it does today** — Claude's native `AskUserQuestion` tool doesn't work under `claude -p` print mode (FLUX-662), so the adapter explicitly disallows it and EH registers an `ask_user_question` MCP tool that surfaces the question in the portal. The tool description literally says *"substitute for the native AskUserQuestion (which can't be fulfilled in `claude -p` print mode)"*.
- **Why** — Designed against a claude-specific limitation.
- **Severity** — `leaky`. The MCP tool itself is still useful for any framework that wants structured pickers; the tool description and the `--disallowed-tools` flag are claude-only.
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`nativeAskBlocked: boolean`); the MCP tool stays.

### B.6 `--mcp-config` phase-profile filtering

- **Location** — [`claude-code.ts:622-633`](../../../engine/src/agents/claude-code.ts) (`buildSpawnMcpConfigArgs`), [`claude-code.ts:89`](../../../engine/src/agents/claude-code.ts) (`filterMcpServersByPhase`), [`claude-code.ts:133`](../../../engine/src/agents/claude-code.ts) (`getEffectiveSpawnServers`).
- **What it does today** — Per FLUX-490 / FLUX-604, EH dynamically composes a per-spawn `.mcp.json` from the user's enabled modules, filters by ticket phase (`grooming` / `implementation` / `review` / `finalize`) and tag conditions, and passes the file via `--mcp-config`. None of this fires for copilot/gemini.
- **Why** — Only claude's CLI accepts `--mcp-config`. Copilot doesn't take an MCP file at all; gemini reads `.gemini/settings.json` and would require a different injection scheme.
- **Severity** — `blocking-for-feature-parity`.
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`spawnTimeMcpConfig: boolean`) + `extract-shared-helper` for the filter logic (already pure). Per-adapter implementations call the shared filter and emit their own injection format.

### B.7 Image attachments

- **Location** — [`claude-code.ts:240-322`](../../../engine/src/agents/claude-code.ts) (`resolveAttachmentAbsPaths`, `attachmentReadInstruction`), interface field at [`types.ts:140+`](../../../engine/src/agents/types.ts) (`SendInputOptions.attachments`).
- **What it does today** — Per FLUX-674 / FLUX-676 the chat composer can paste images; the claude adapter resolves each to an absolute sidecar path and appends a "Read the image at …" instruction to the resumed prompt. Routes (C.1) import the helpers directly from `claude-code.ts`.
- **Why** — Implemented for claude first; copilot/gemini have the optional `attachments` arg per the interface but ignore it.
- **Severity** — `leaky`. The portal still accepts pastes for copilot/gemini sessions; they silently never reach the agent.
- **Disposition** — `capability-flag-in-CLI_CAPABILITIES` (`imageAttachments: boolean`) + per-adapter resolver hook on `AgentAdapter`; the path resolver moves to a shared helper.

### B.8 The `__board__` orchestrator (largest single hole) · ✅ RESOLVED (FLUX-904)

> Lifted out of `claude-code.ts` into a `BoardAdapter`: the sentinel `BOARD_CONVERSATION_ID` + the `BoardAdapter` interface live in the dependency-free `engine/src/agents/board.ts` seam (single home — the 4 duplicated `'__board__'` literals in claude-code/board-reprime/extract/tasks now import it); the Claude implementation is `engine/src/agents/claude-board.ts`; routes resolve it via `getBoardAdapter()` (`agents/index.ts`) instead of deep-importing the Claude file (C.1). Also resolves **C.2** (`routes/tasks.ts` imports the sentinel from the seam) and **C.4** (the board session's `framework` is the adapter's, not a literal). The attachment helpers (C.1's other half) moved to `shared.ts`. `claude-board.ts` still shares the Claude spawn/parse internals via an intra-adapter import until FLUX-932. Locked by the B.8 tests in `adapter-contract.test.ts`.

- **Location** — [`claude-code.ts:1058-1191`](../../../engine/src/agents/claude-code.ts): `BOARD_CONVERSATION_ID`, `spawnClaudeForBoard`, `buildBoardPrompt`, `boardMcpArgs`, `wireBoardProc`, `startBoardSession`, `sendBoardInput`. Plus the call sites in [`routes/cli-session.ts:30`](../../../engine/src/routes/cli-session.ts) and [`routes/tasks.ts:24`](../../../engine/src/routes/tasks.ts).
- **What it does today** — The board-chat orchestrator (the "global agent" the user talks to from the board, not from a single ticket) is a parallel `start` / `sendInput` pair that lives entirely inside the claude adapter. It has its own MCP arg construction, its own prompt builder, its own transcript file (`<fluxDir>/transcripts/__board__.jsonl`), its own session id constant, and its own per-process wiring.
- **Why** — Built on claude when there was only one adapter. Has not been generalized.
- **Severity** — **`blocking`**. There is no path to swap the orchestrator's framework.
- **Disposition** — `new-BoardAdapter-interface`. Separate interface from per-ticket `AgentAdapter` because the contract is genuinely different (no ticket id, persistent transcript, different MCP toolset). The current claude impl becomes its first implementation; routes (C.1) call `getBoardAdapter()` instead of importing from the claude file.

---

## C. Engine peripherals — claude leakage outside `engine/src/agents/`

### C.1 `routes/cli-session.ts:30` — direct import from `claude-code.ts`

- **Location** — [`routes/cli-session.ts:30`](../../../engine/src/routes/cli-session.ts).
- **What it does today** — `import { BOARD_CONVERSATION_ID, startBoardSession, sendBoardInput, resolveAttachmentAbsPaths, attachmentReadInstruction } from '../agents/claude-code.js'`. The CLI-session route layer reaches *directly* into the claude adapter for both board-chat surface and image-attachment helpers.
- **Why** — Helpers were colocated with the only consumer at the time.
- **Severity** — **`blocking`** (couples the route layer to one specific adapter's filename).
- **Disposition** — `new-BoardAdapter-interface` (for the board helpers) + `extract-shared-helper` (for the attachment helpers).

### C.2 `routes/tasks.ts` — `BOARD_CONVERSATION_ID` import + asset-upload synthetic ticket

- **Location** — [`routes/tasks.ts:24`](../../../engine/src/routes/tasks.ts) (import), `routes/tasks.ts:646-649` (asset-upload accepts `__board__` as ticket id).
- **What it does today** — The asset-upload route allows `__board__` as a synthetic ticket id so board-chat images can land under `assets/__board__/`. Constant is imported from the claude adapter.
- **Severity** — `leaky` (pairs with B.8).
- **Disposition** — Constant moves out of the adapter file as part of `new-BoardAdapter-interface`.

### C.3 `routes/cli-session.ts` — four `framework || 'claude'` fallbacks · ✅ RESOLVED (FLUX-905)

> **C.3 + C.7 + C.17 resolved.** `agents/index.ts` now exports `resolveDefaultFramework()` (returns `configCache.defaultAgent`, resolving `'auto'`/unknown to the first registered runtime adapter). The 4 route fallbacks and the 2 MCP fallbacks (FLUX-882 had already merged the 3rd into the consolidated `delegate` handler) use it instead of a hardcoded `'claude'` — the default is config/registry-driven; an explicit-but-invalid framework still 400s. **C.17:** `AGENT_AUTHOR_PATTERN` (history.ts) is now built from `MODEL_FAMILIES` (a central per-framework map in `agents/types.ts`) ∪ `'agent'`, so a new framework/model is one edit, not a buried regex. The FLUX-938 allowlist's `claude-default-fallback` category is now empty (ratcheted 14 → 12 fingerprints). **Deferred to a small follow-up:** C.9 (`permission_prompt` description), C.14 (`transcript.ts` JSDoc), and C.15 (Serena `--context` derived from the framework — needs the spawning framework threaded into the module template; it's a tuning hint that falls back to `claude-code`, not a correctness gap).

- **Location** — [`routes/cli-session.ts:400`](../../../engine/src/routes/cli-session.ts), `:555`, `:616`, `:668`.
- **What it does today** — `String(req.body?.framework || 'claude').trim().toLowerCase()`. A POST without a `framework` field silently becomes a claude session.
- **Why** — Convenience fallback while only claude existed.
- **Severity** — `leaky`.
- **Disposition** — Default to `configCache.defaultAgent`; respond `400` when neither is set.

### C.4 `routes/cli-session.ts:357` — board session literal

- **Location** — [`routes/cli-session.ts:357`](../../../engine/src/routes/cli-session.ts).
- **What it does today** — The board session record is created with `framework: 'claude'` hardcoded.
- **Severity** — `blocking` (pairs with B.8).
- **Disposition** — Derived from the configured BoardAdapter id.

### C.5 Resume-readiness via the misnamed field

- **Location** — [`routes/cli-session.ts:768`](../../../engine/src/routes/cli-session.ts) and `:808` — `if (!boardSession.claudeSessionId)` / `if (!session.claudeSessionId)`. Also [`session-store.ts:81`](../../../engine/src/session-store.ts) — `summary.resumable = ... && !!session.claudeSessionId`.
- **What it does today** — REST gate that decides whether a session can be resumed.
- **Why** — Field was named when there was only one adapter (D.1). · ✅ Resolved with D.1 (FLUX-902): the gate now reads `resumeSessionId`.
- **Severity** — `leaky`.
- **Disposition** — `rename-only` (D.1).

### C.6 `session-store.ts:429` — `validatePatternSupport`

- **Location** — [`session-store.ts:429`](../../../engine/src/session-store.ts).
- **What it does today** — Validates whether a framework supports a requested orchestration pattern (`supervisor` / `scatter-gather` / `relay`) by reading [`CLI_CAPABILITIES`](../../../engine/src/agents/types.ts).
- **Severity** — **clean adapter point — none.**
- **Disposition** — `leave-with-justification`. This is the pattern every other capability gate should mimic. Documented here so it doesn't get refactored away by mistake.

### C.7 `mcp-server.ts` — three `EVENT_HORIZON_FRAMEWORK || 'claude'` fallbacks

- **Location** — [`mcp-server.ts:1056`](../../../engine/src/mcp-server.ts), `:1100`, `:1145`.
- **What it does today** — `const framework = process.env.EVENT_HORIZON_FRAMEWORK || 'claude'`. When the MCP server can't tell which framework called it, it assumes claude when deciding which delegation / board affordances to expose.
- **Why** — Convenience fallback.
- **Severity** — `leaky`.
- **Disposition** — Return an explicit error or an empty toolset rather than silently assuming.

### C.8 `mcp-server.ts` — `EH_CONVERSATION_ID` routing

- **Location** — [`mcp-server.ts:1206`](../../../engine/src/mcp-server.ts), `:1256`, `:1291` — the `propose_board_rebase`, `permission_prompt`, `ask_user_question` tool handlers each include `conversationId: process.env.EH_CONVERSATION_ID || null` in their POST body so the portal can route the picker back to the originating chat.
- **What it does today** — From a claude session the env var is set; from copilot / gemini it's always `null` (see A.6) and the picker falls into the global overlay.
- **Severity** — **`blocking`** — pairs with A.6.
- **Disposition** — Fixed by A.6.

### C.9 `permission_prompt` MCP tool description

- **Location** — [`mcp-server.ts:1220+`](../../../engine/src/mcp-server.ts).
- **What it does today** — The tool description begins *"Internal — Claude Code calls this via --permission-prompt-tool…"*.
- **Severity** — `cosmetic`.
- **Disposition** — Generalize the description; the tool can stay claude-specific while only claude needs it.

### C.10 `mcp-server.ts` — `pausedForInput` set from MCP handlers

- **Location** — [`mcp-server.ts:407`](../../../engine/src/mcp-server.ts), `:605`.
- **What it does today** — When an agent calls `change_status('Require Input')` via MCP, the handler sets `session.pausedForInput = true` on whatever session is active.
- **Severity** — `leaky` — pairs with B.2.
- **Disposition** — Fixed by B.2.

### C.11 `board-rebase.ts:189` — hardcoded `framework: 'claude'`

- **Location** — [`board-rebase.ts:189`](../../../engine/src/board-rebase.ts).
- **What it does today** — The board-rebase proposal session is POSTed with `framework: 'claude'` hardcoded.
- **Severity** — `leaky`.
- **Disposition** — Derive from the configured BoardAdapter id (B.8).

### C.12 `board-digest.ts` — `__board__` filter

- **Location** — [`board-digest.ts:54`](../../../engine/src/board-digest.ts) (`taskId !== '__board__'`).
- **What it does today** — Filters board sessions out of the recent-activity digest.
- **Severity** — `cosmetic`.
- **Disposition** — Pairs with B.8.

### C.13 `context-budget-metrics.ts` — claude-only prompt measurement

- **Location** — [`context-budget-metrics.ts:4`](../../../engine/src/context-budget-metrics.ts), `:51`.
- **What it does today** — Imports `buildInitialPrompt` only from `claude-code.ts`. The context-budget telemetry therefore measures the claude variant only, while copilot and gemini build prompts that include the full ticket body (A.2) and are larger.
- **Severity** — `leaky` (silent under-reporting).
- **Disposition** — After A.2 extraction, point at the shared helper.

### C.14 `transcript.ts` — JSDoc references claude stream-json

- **Location** — [`transcript.ts:24, 100, 157`](../../../engine/src/transcript.ts).
- **What it does today** — Documents the per-ticket transcript as `claude` stream-json. The format is actually generic JSONL — any adapter's raw events get appended.
- **Severity** — `cosmetic`.
- **Disposition** — Edit the JSDoc.

### C.15 `modules.ts` — Serena spawned with `--context claude-code`

- **Location** — [`modules.ts:166`](../../../engine/src/modules.ts), `:170`.
- **What it does today** — The built-in Serena module template (both the stdio and `sharedHttp` variants) launches Serena with `--context claude-code`. That flag tunes Serena's tool-call conventions for Claude's tool surface.
- **Why** — Claude was the only client when the template was authored.
- **Severity** — `leaky` (Serena still works for copilot/gemini but tuned for the wrong conventions).
- **Disposition** — Derive the context flag from the spawning framework; fall back to `claude-code` if Serena lacks a profile for the target.

### C.16 `notifications.ts` — `checkFrameworkHealth` / `checkSkillStaleness`

- **Location** — [`notifications.ts:148`](../../../engine/src/notifications.ts), `:186`.
- **What it does today** — Health and staleness checks across the full installer-known framework set (claude / copilot / gemini / cursor / cline / windsurf / antigravity).
- **Severity** — **clean — none.**
- **Disposition** — `leave-with-justification`. Pattern to mimic.

### C.17 `history.ts:220` — `AGENT_AUTHOR_PATTERN`

- **Location** — [`history.ts:220`](../../../engine/src/history.ts) — `const AGENT_AUTHOR_PATTERN = /\b(agent|claude|gpt|copilot|gemini|opus|sonnet|haiku|codex)\b/i;`.
- **What it does today** — Decides whether a comment author string represents an agent (e.g. `'Claude (Opus 4.8)'`) for the user-comment launch-focus feature.
- **Why** — Mixes adapter ids (`claude`, `copilot`, `gemini`) with Claude model family names (`opus`, `sonnet`, `haiku`) and other vendor markers (`gpt`, `codex`). Whenever a new model family ships, the regex has to be updated.
- **Severity** — `leaky`.
- **Disposition** — Drive from `Object.keys(registry)` + a per-adapter `modelFamilies: string[]` field on the manifest.

---

## D. Naming + type leaks

### D.1 `claudeSessionId` field name — used by all three adapters · ✅ RESOLVED (FLUX-902)

> Renamed to `resumeSessionId` across engine + portal + tests (semantics-preserving). The HITL-envelope field of the same name (`hitl-prompts.ts` / `ask-questions.ts` / `permission-prompts.ts` + `index.ts` `resumePointerFor`) was renamed too for consistency; its persisted `open-prompts.json` value is not yet consumed for resume (deferred Phase 3), so the persisted-key change is behavior-neutral.

- **Location** — [`types.ts:96`](../../../engine/src/agents/types.ts). Call sites: every place a session is resumed.
- **What it does today** — Stores the framework's native resume id (claude → the `session_id` field on its `system` event; copilot → `session.created.id` or `assistant.parentId`; gemini → `session_id`). 18+ call sites across engine + portal + tests.
- **Why** — Named when there was only one adapter; never renamed when copilot/gemini reused the field.
- **Severity** — `leaky`.
- **Disposition** — `rename-only` to `resumeSessionId` (semantics-preserving — use the language-server refactor; no behavior change).

### D.2 `CLI_CAPABILITIES` missing `effort`

- **Location** — [`types.ts:27`](../../../engine/src/agents/types.ts).
- **What it does today** — Canonical capability table tracking `resume / background / supervisor / scatter / toolGating / structuredOutput` per framework. Effort support and effort-flag literal live in the per-adapter `PROVIDER_CAPABILITIES` (A.8) instead.
- **Severity** — `leaky`.
- **Disposition** — Extend `CLI_CAPABILITIES` with `effort: { supported: boolean; flag?: string }`; delete A.8.

### D.3 Closed `CliFramework` enum vs the installer's 8-framework world

- **Location** — [`types.ts:10`](../../../engine/src/agents/types.ts) — `export type CliFramework = 'claude' | 'copilot' | 'gemini'`.
- **What it does today** — The runtime adapter type is a closed three-member union. The skill installer (F) knows about eight.
- **Severity** — `leaky` at the type level; `blocking` at the product level (see F).
- **Disposition** — Driven by F.

### D.4 Registry key vs manifest id mismatch

- **Location** — [`agents/index.ts:7`](../../../engine/src/agents/index.ts).
- **What it does today** — `Map(['claude' → new ClaudeCodeAdapter()])`. The registry key is `'claude'`; the adapter's manifest id is `'claude-code'`. A consumer looking up by either may get null if they pick the wrong one.
- **Severity** — `cosmetic`.
- **Disposition** — Pick one (recommend registry-key = manifest-id).

### D.5 Static registry — no plug-in mechanism

- **Location** — [`agents/index.ts`](../../../engine/src/agents/index.ts).
- **What it does today** — Static `Map` literal. Adding a framework requires editing this file + `types.ts` + nine helpers in section A.
- **Severity** — `leaky` once the helpers are extracted (A); irrelevant before.
- **Disposition** — After A is done, `extract-shared-helper` makes new-adapter registration a one-liner. No formal plug-in API needed yet.

---

## E. Portal

> **✅ RESOLVED — FLUX-906 (Phase 2, portal decoupling).** The portal no longer hardcodes Claude for
> feature gates or the `'auto'` default. `/api/config` now serves three values the portal used to assume:
> `cliCapabilities` (FLUX-901), `defaultFramework` (the engine-resolved `'auto'`, via `resolveDefaultFramework()`),
> and `boardConversationId`. New portal seam: **`frameworkSupports(config, framework, capability)`** in
> [`utils.ts`](../../../portal/src/utils.ts) — the generic replacement for `framework === 'claude'` gates.
> The ratcheting boundary guard (FLUX-938) allowlist shrank **12 → 10** fingerprints (E.6 + E.4 removed).
> **E.3, E.7, and the OnboardingWizard "(default)" badge are documented leave-with-justification** —
> framework-IDENTITY, not capability (annotated inline + kept allowlisted).

### E.1 `BOARD_CONVERSATION_ID` duplicated in portal

- **Location** — [`portal/src/api.ts`](../../../portal/src/api.ts).
- **What it does today** — Portal-side `BOARD_CONVERSATION_ID = '__board__'` constant. Must stay in sync with engine. 30+ references in portal components.
- **Severity** — `leaky` (magic-string sync risk).
- **Disposition** — Ship via `/api/config` or a shared types package.
- **✅ FLUX-906** — Engine serves `boardConversationId` on `/api/config` (from [`agents/board.ts`](../../../engine/src/agents/board.ts), moved out of `claude-code.ts` in FLUX-904). The portal **keeps** its sync constant — 30+ call sites compare against it at render/handler time and can't await config — but `fetchConfig()` now **cross-checks** it against the engine value and dev-warns on drift, so the two can't silently diverge.

### E.2 `resolveEffectiveAgent` defaults to claude

- **Location** — [`portal/src/utils.ts`](../../../portal/src/utils.ts).
- **What it does today** — `framework === 'auto' ? 'claude' : framework`. When `config.defaultAgent` is `'auto'`, the portal picks claude.
- **Severity** — `leaky`.
- **Disposition** — Engine resolves `'auto'`; portal asks.
- **✅ FLUX-906** — All callers now pass `config.defaultFramework` (the engine-resolved, concrete value) instead of `config.defaultAgent` (which may be the `'auto'` sentinel). The residual `'auto' → 'claude'` floor is reached only before `/api/config` loads — a documented pre-load default, not a gate (the boundary guard doesn't match the ternary form).

### E.3 Duplicated `CliFramework` enum

- **Location** — [`portal/src/types.ts`](../../../portal/src/types.ts).
- **What it does today** — `'claude' | 'copilot' | 'gemini'` — same shape as the engine enum but separately maintained.
- **Severity** — `leaky`.
- **Disposition** — Shared types package (or codegen from `/api/config`).
- **🔵 FLUX-906 — documented leave-with-justification.** Portal and engine are separate TS builds with no shared package; the union (and the new `CliCapabilities` mirror) is a STRUCTURAL mirror, while the runtime contract is the served `cliCapabilities` table. Annotated inline in `types.ts`; keys kept in lockstep with the engine union.

### E.4 `useChatSession` hardcodes `framework: 'claude'`

- **Location** — [`portal/src/hooks/useChatSession.ts`](../../../portal/src/hooks/useChatSession.ts).
- **What it does today** — When starting a chat session from this hook, the framework is hardcoded.
- **Severity** — `leaky`.
- **Disposition** — Thread through the framework picker.
- **✅ FLUX-906** — `StartSessionOptions.framework` is now optional; `startFresh` **omits** it so the engine resolves the configured default (`resolveDefaultFramework()`). A fresh chat now follows `defaultAgent` instead of always Claude (a latent fix — e.g. `defaultAgent: gemini` makes fresh chats use gemini). Allowlist entry removed.

### E.5 SSE subscriber list includes `assistantDelta`

- **Location** — [`portal/src/AppContext.tsx`](../../../portal/src/AppContext.tsx).
- **What it does today** — Global SSE channel subscribes to `assistantDelta`; only claude emits it (B.3). No-op for other adapters.
- **Severity** — `cosmetic`.
- **Disposition** — Pairs with B.3 (out of FLUX-906 scope — cosmetic, no leak).

### E.6 `agentActions.ts` — supervisor gate via literal string

- **Location** — [`portal/src/agentActions.ts`](../../../portal/src/agentActions.ts).
- **What it does today** — `cfg?.pattern === 'supervisor' && (framework === 'claude' || framework === 'gemini')` — duplicates the capability check from the engine's `CLI_CAPABILITIES` as a hardcoded literal.
- **Severity** — `leaky` (drift risk — if the engine table changes, portal does not).
- **Disposition** — Drive from `CLI_CAPABILITIES` (ship through `/api/config`).
- **✅ FLUX-906** — `launchPhaseDefault` now takes `supervisorCapable`, which all 3 callers pass as `frameworkSupports(config, framework, 'supervisor')` — read straight off the served capability table. Hardcoded literal removed; allowlist entry removed.

### E.7 `AgentSection.tsx` — claude-or-auto settings branch

- **Location** — [`portal/src/components/settings/AgentSection.tsx`](../../../portal/src/components/settings/AgentSection.tsx).
- **What it does today** — `targetFramework === 'claude' || targetFramework === 'auto'` settings panel branch.
- **Severity** — `leaky`.
- **Disposition** — Drive from manifest (`adapter.manifest.configSchema`).
- **🔵 FLUX-906 — documented leave-with-justification.** These are per-framework model-settings cards ("Claude Code Models" → `integrations.claudeCode`) — framework-IDENTITY config, not a capability gate (there is no `cliCapabilities` flag for "has a model-name input", and the copy is intrinsically per-CLI). Annotated inline; kept allowlisted. A future manifest-driven settings list (D-series) is the right home if this is ever generalized.

### E.8 `ChatDock.tsx` — 12+ `BOARD_CONVERSATION_ID` references

- **Location** — `portal/src/components/ChatDock.tsx`.
- **What it does today** — Heavy coupling for the board card render (pinned, can't close, special `cardState`, hardcoded conversation id checks, sidecar `assets/__board__/`, etc.).
- **Severity** — `leaky` (pairs with E.1).
- **Disposition** — Fixed by E.1 + B.8.
- **✅ FLUX-906** — Resolved with E.1: every reference imports the single `BOARD_CONVERSATION_ID` from `api.ts`, which is now cross-checked against the engine-served `boardConversationId`. These are sentinel comparisons (`id === BOARD_CONVERSATION_ID`), not per-CLI coupling — not a framework leak.

---

## F. The skill-installer asymmetry (largest single product gap)

> **✅ RESOLVED — FLUX-907 (Phase 3, the epic's final ticket). Picked Option 3 (split semantics).**
> The asymmetry is **intentional and now made explicit**, not closed by force:
> - **Installer stays broad (8)** — writing EH's skill files for any agent the user already has (Cursor,
>   Cline, Windsurf, Antigravity, …) is genuinely useful and stays.
> - **Runtime stays at 3** — `claude` / `copilot` / `gemini` are the only frameworks EH can launch &
>   drive. **No new runtime adapter was authored** (that is high-cost and explicitly out of the epic).
> - **The gap is surfaced** — the engine serves an explicit **`runtimeFrameworks`** list on `/api/config`
>   (`getRuntimeFrameworks()` = the adapter registry keys; a new adapter widens it automatically). The
>   portal reads it via `isRuntimeFramework()` ([`utils.ts`](../../../portal/src/utils.ts)) and **badges
>   install-only frameworks "Skills only"** in the framework picker ([`FrameworkSelector.tsx`](../../../portal/src/components/FrameworkSelector.tsx))
>   and the first-run onboarding grid ([`OnboardingWizard.tsx`](../../../portal/src/components/OnboardingWizard.tsx),
>   with a one-line legend). So "install ≠ run" is visible at the point of choice instead of being a silent surprise.
>
> **Mental model:** *installer = "write rules for any agent you have"; runtime = "the agents EH can actually pilot."*
> With this Done, FLUX-851's epic-level acceptance is met (clean grep set, board orchestrator framework-agnostic,
> capability-gated behaviors, `claudeSessionId`→`resumeSessionId` rename, docs refreshed).

- **Location** — [`workflow-installer.ts`](../../../engine/src/workflow-installer.ts) (detection at lines 78-130; `skillDestinationFor` at lines 87-105; `skillModuleDestinationFor` at lines 108-117; `instructionsDestinationFor` at lines 120-138).
- **What it does today** — The skill installer detects and writes for **eight** frameworks: `claude`, `copilot`, `gemini`, `cursor`, `cline`, `windsurf`, `antigravity`, `generic`. Each gets its own per-framework skill destination, instructions destination, and detection rule (presence of `.gemini/`, `.cursor/`, `.cline/`, `.windsurf/`, `.claude/`).
- **What the agent runtime knows** — **three**: `claude`, `copilot`, `gemini` ([`agents/index.ts:7`](../../../engine/src/agents/index.ts)).
- **The consequence** — Event Horizon can install its orchestrator skill into a Cursor or Windsurf workspace, but it cannot actually launch a session against those CLIs. The skill installer is the most adapter-pluggable part of the system; the runtime is the most locked-down.
- **Severity** — **`blocking-at-the-product-level`**.
- **Disposition** — The follow-up ticket is one of:
  1. **Runtime catches up** — author runtime adapters for cursor / cline / windsurf / antigravity (very high cost; each has a non-trivial CLI surface).
  2. **Installer narrows** — drop the non-runtime frameworks from the installer; document that EH only integrates with the three it can drive.
  3. **Split semantics** — keep installer at 8 (it really is the right thing to write skill files for any agent the user has), runtime at 3, and have a separate "supported runtime adapter" list surfaced in the portal.

Option 3 is the closest fit to user expectation. **FLUX-907 picked it** (see the resolution banner above).

> **🔵 FLUX-1412** — The skill-layout branch (`resolvedFramework === 'claude'`, a leftover per-CLI literal from FLUX-1377) is now `SKILL_INSTALL_STRATEGY[resolvedFramework]`, a `Record<ResolvedFramework, 'modular' | 'core' | 'concatenated'>` table in `workflow-installer.ts`. Still installer-internal (this is a skill-layout axis on the 8-framework `ResolvedFramework`, not the 3-CLI runtime `CliFramework` — it cannot be expressed via `CLI_CAPABILITIES`), just data-driven instead of a literal, so `check-adapter-boundary.mjs` no longer flags it. The 3 `framework: 'claude'` test-fixture leaks it also caught (`build-initial-prompt.test.ts`, `resume-or-dispatch.test.ts`, `workflow-installer-core.test.ts`) are sanctioned exceptions — a test of the claude adapter must name `'claude'` — allowlisted per the existing `mcp-phase-profiles.test.ts` precedent.

---

## G. Defaults + config

### G.1 `defaultAgent: 'claude'`

- **Location** — [`config.ts:62`](../../../engine/src/config.ts).
- **What it does today** — Board-wide default agent for new sessions. Already user-overridable.
- **Severity** — `none` (expected default for a tool that originated on claude).
- **Disposition** — `leave-with-justification`.

### G.2 `integrations` config slot

- **Location** — [`config.ts:66-80`](../../../engine/src/config.ts) — `integrations: { claudeCode, geminiCli, copilotCli }`.
- **What it does today** — Three first-class config slots for per-CLI grooming/implementation model selection. Each adapter reads its slot via `framework === '<self>'` in its `startCliSession` ([`claude-code.ts:610-613`](../../../engine/src/agents/claude-code.ts), [`copilot.ts:492`](../../../engine/src/agents/copilot.ts), [`gemini.ts:476`](../../../engine/src/agents/gemini.ts)).
- **Severity** — **clean — none.**
- **Disposition** — `leave-with-justification`. Symmetric.

### G.3 `permissions: { boardDefault, ticketDefault }`

- **Location** — [`config.ts:90-95`](../../../engine/src/config.ts).
- **What it does today** — Default `permissionMode` for the two surfaces. Only meaningful for claude (B.4).
- **Severity** — `leaky` (paired with B.4).
- **Disposition** — Hide the picker / disable the defaults when the active adapter lacks `permissionGating`.

---

## Verification — grep coverage

The doc was cross-checked against the following grep set in `engine/src/**/*.ts` + `portal/src/**/*.{ts,tsx}`. Every hit lands in a row above (or in the `clean — none` justifications C.6 / C.16 / G.2).

```
framework\s*===?\s*['"]claude
framework\s*!==?\s*['"]claude
framework:\s*'claude'
'claude'\s*\)
claudeSessionId
BOARD_CONVERSATION_ID|__board__
claudeIntegration|claudeCli|claudeCode
claude\.exe|@anthropic-ai/claude-code
--include-partial-messages|--permission-prompt-tool|--dangerously-skip-permissions|--disallowed-tools|AskUserQuestion
EH_CONVERSATION_ID|EVENT_HORIZON_FRAMEWORK
permissionMode|pausedForInput|assistantDelta
ClaudeCodeAdapter|claude-code\.js
```

If a new claude-only surface is added after this audit, it MUST appear in this set or the set MUST be extended.

> **Automated now (FLUX-938).** This grep set is enforced by [`engine/scripts/check-adapter-boundary.mjs`](../../../engine/scripts/check-adapter-boundary.mjs) (`npm run check:boundary`), which fails on any per-CLI leak **outside `engine/src/agents/`** that isn't in `adapter-boundary-allowlist.json`. The allowlist is seeded with today's known leaks (the C/E rows above) and **only shrinks**: each epic cleanup ticket (FLUX-902 rename, FLUX-904 board lift, FLUX-905 route/MCP hygiene, FLUX-906 portal) re-seeds it after removing its leaks (`--seed`, with the diff reviewed). A brand-new coupling fails CI rather than silently joining the ~50-leak pile. Add a pattern to the script when a new category of coupling needs guarding.

---

## Follow-ups this doc enables (created separately)

The implementation work batches by disposition. **One follow-up ticket per batch, not per row:**

1. **Helper extraction (Phase 1)** — A.1, A.3, A.4, A.5, A.6, A.7, A.8, A.9 into `engine/src/agents/shared.ts`.
2. **Capability flags (Phase 1)** — D.2 + B.1, B.3, B.4, B.5, B.6, B.7 → extend `CLI_CAPABILITIES`. Portal reads via `/api/config`.
3. **Field rename (Phase 1)** — D.1 `claudeSessionId` → `resumeSessionId` via the language server.
4. **BoardAdapter interface (Phase 2)** — B.8, C.1, C.2, C.4, C.11, C.12.
5. **Route + MCP defaults hygiene (Phase 2)** — C.3, C.7, C.9, C.14, C.15, C.17.
6. **Portal decoupling (Phase 2)** — E.1, E.2, E.3, E.4, E.6, E.7, E.8.
7. **Runtime ↔ installer reconciliation (Phase 3, design ticket first)** — F. ✅ **Landed (FLUX-907):** picked Option 3 (split semantics) — engine serves `runtimeFrameworks` on `/api/config`; portal badges install-only frameworks "Skills only" in the framework picker + onboarding. No new runtime adapter authored. **This was the epic's final ticket — FLUX-851 acceptance met.**
8. **Test safety net (Phase 1a)** — separate ticket; informed by this doc so the tests target the right invariants (originally proposed for FLUX-700 itself, moved out). ✅ **Landed (FLUX-903):** [`engine/src/adapter-contract.test.ts`](../../../engine/src/adapter-contract.test.ts) — the HARD GATE before Phase 2. Enabled locks: A.6 `cleanChildEnv` (HITL env set for every framework), the `CLI_CAPABILITIES` contract (completeness + B.1–B.7 Claude-only), and a per-adapter spawn smoke (skip-with-reason if the CLI binary is absent). Skip-with-reason scaffolds map to their enabling tickets: the A.1 stdout-parse contract → ✅ **flipped to real fixture tests in FLUX-932** (feeds each adapter's real `attachStdoutProcessing` captured-shape JSONL through a fake `ChildProcess`, asserts on session-state transitions — this is what caught the second Gemini `cumulativeOutput` gap above); the B.8 `__board__` contract → FLUX-904.

No code change here. Each follow-up is its own ticket.
