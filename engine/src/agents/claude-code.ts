import { log } from '../log.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, tasksCache, estimateCostUSD } from '../task-store.js';
import { resolveTaskExecutionRoot, resolveResumeExecutionRoot, assertIsolatedSpawnRoot } from '../task-worktree.js';
import { workspaceRoot as canonicalWorkspaceRoot } from '../workspace.js';
import { notifyGroupSessionTerminal, notifyDelegationComplete, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { emitOperationEvent, type OperationOutcome } from '../operation-telemetry.js';
import { appendTranscriptLine, appendTranscriptEvent } from '../transcript.js';
import type { DispatchLifecycle } from '../projection.js';
import { killProcessTree } from '../kill-process-tree.js';
import { checkFrameworkHealth, checkSkillStaleness } from '../notifications.js';
import { captureTurnStartState, clearNeedsActionIfSet, flagIfParked, raiseNeedsAction } from '../parked-ticket.js';
import { buildMemberScopeArgs } from '../group.js';
import { buildGroupDocsScopeArg } from '../group-member-worktree.js';
import { getModuleMcpServers, getActiveModules, getWorkspaceMcpServers } from '../modules.js';
import { getProbeStatus } from '../module-probe.js';
import { signConversation } from '../session-binding.js';
import { buildMcpServerEntry } from '../workflow-installer.js';
import { ensureSharedServer, getSharedServerUrl, isSharedHttpPlatformProven } from '../shared-mcp-server.js';
import { buildResumePreamble } from '../resume-preamble.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest, SendInputOptions } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import { EFFORT_LEVELS, type EffortLevel, cleanChildEnv, checkBinaryInstalled, appendSessionOutput, appendErrorToSession, enqueueSessionWrite, flushSessionOutput, resolveAttachmentAbsPaths, attachmentReadInstruction, activityFor, attachStdoutProcessing as sharedAttachStdoutProcessing, resolveClaudeExePath, buildInitialPrompt, terminalizeResumedExit, surfaceResumeFailure, isChatEditGated, prependEditGateNote } from './shared.js';
import { BOARD_CONVERSATION_ID } from './board.js';

/**
 * One entry of the `--mcp-config` server map: either a shared HTTP endpoint (FLUX-579) or a
 * per-session stdio spawn spec, plus whatever extra keys a workspace `.mcp.json` server or the
 * `alwaysLoad` flag (FLUX-604) tack on. A precise union would trip excess-property checks on
 * those additions, so this stays a permissive record — the shape is genuinely open-ended
 * external config (module servers, workspace .mcp.json, gh-cli-adjacent MCP servers), not a type
 * this file owns.
 */
type McpServerConfig = Record<string, unknown>;

/** Narrow shape of the loosely-typed ticket record this adapter actually reads from. */
interface ClaudeTask {
  status?: string;
  tags?: string[];
  effortLevel?: string;
  branch?: string;
}

// Build --mcp-config JSON string for active module MCP servers.
// Prefers an engine-managed shared HTTP server when one is ready (so all sessions
// reuse one language-server process); otherwise falls back to a per-session stdio
// spawn. Skips modules whose probe status is 'error' to avoid cascading failures.
function buildModuleServerMap(phase?: string, tags?: string[], projectPath?: string): Record<string, McpServerConfig> {
  const stdioServers = getModuleMcpServers(phase, tags);
  const filtered: Record<string, McpServerConfig> = {};
  // FLUX-579: the shared HTTP server is keyed per (module, worktree). Look it up
  // for THIS session's execution root so a worktree session gets its own server,
  // not the workspace-root one. Falls back to the workspace root for board /
  // single-checkout sessions (no distinct worktree path) — same behavior as before.
  const lookupPath = projectPath || canonicalWorkspaceRoot || '';
  for (const m of getActiveModules(phase, tags)) {
    // Shared HTTP path: one server per (module, worktree), on proven platforms.
    if (m.sharedHttp && isSharedHttpPlatformProven()) {
      const url = lookupPath ? getSharedServerUrl(m.id, lookupPath) : null;
      if (url) filtered[m.id] = { type: 'http', url };
      // Not ready yet (still starting / failed) → omit; don't stdio-fallback on a
      // proven platform, which would defeat the point and spawn N stacks.
      continue;
    }
    // Stdio path (no sharedHttp, or unproven platform): keep prior behavior.
    const server = stdioServers[m.id];
    if (server && getProbeStatus(m.id).status !== 'error') {
      filtered[m.id] = { type: 'stdio', ...server };
    }
  }
  return filtered;
}

// FLUX-1004 (epic FLUX-996): a few seconds, not HANDSHAKE_TIMEOUT_MS's full 45s — this is
// a WAIT cap on the caller, not a change to how long ensureSharedServer itself is allowed
// to keep trying. See the comment below for why capping only the wait is safe.
const PRE_SPAWN_WAIT_CAP_MS = 5_000;

/** Race a promise against a short cap; a still-pending promise is abandoned here (not cancelled) — its
 * own work (and any cache/state it sets on completion) continues in the background regardless. */
function raceWithCap<T>(p: Promise<T>, capMs: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), capMs))]);
}

/**
 * FLUX-579: start (or reuse) the per-worktree shared HTTP server for every active
 * shared-http module pinned to THIS session's execution root, BEFORE we build the
 * MCP config that looks it up by (module, worktree). The module probe only starts
 * a server for the workspace root, so without this a worktree session would find
 * no server for its own tree (and a proven platform omits the stdio fallback) —
 * it would get NO shared server, or, pre-FLUX-579, the wrong workspace-root one.
 * Idempotent and best-effort: a single-checkout session whose root IS the
 * workspace root just reuses the probe's server.
 *
 * FLUX-1004 (epic FLUX-996): this is awaited on the spawn/chat-turn request path (below,
 * and on the resume path) — a cold Serena start could block it for up to
 * HANDSHAKE_TIMEOUT_MS (45s), stalling every spawn/turn behind a language-server boot.
 * Cap the WAIT here to PRE_SPAWN_WAIT_CAP_MS rather than the underlying resolution: each
 * server's readiness races against the cap, but a still-starting server's own promise
 * keeps running in `ensureSharedServer`'s `inflight`/`servers` maps regardless of whether
 * THIS caller gave up on it — so the NEXT turn's call finds it already ready (or already
 * in flight) instead of restarting it. A server that isn't ready in time is simply omitted
 * from THIS turn's MCP config: `buildModuleServerMap` already degrades gracefully on a
 * proven platform (no stdio fallback, just skip — see its FLUX-579 comment), so the agent
 * spawns without that one server for this turn rather than waiting on it.
 */
export async function ensureSharedServersForRoot(projectPath: string, phase?: string, tags?: string[]): Promise<void> {
  if (!projectPath || !isSharedHttpPlatformProven()) return;
  const shared = getActiveModules(phase, tags).filter(m => m.sharedHttp);
  await Promise.all(shared.map(m => raceWithCap(ensureSharedServer(m, projectPath).catch(() => null), PRE_SPAWN_WAIT_CAP_MS)));
}

/**
 * FLUX-1213: the event-horizon server is a single shared HTTP mount (FLUX-645) — every session's
 * `event-horizon` MCP client points at the same URL, so the engine can no longer tell sessions
 * apart via `process.env.EH_CONVERSATION_ID` (that's the engine's own process-global env, not any
 * particular caller's). Instead, carry this spawn's bound conversationId + its HMAC token
 * (verified engine-side by `verifyConversation`, same as the existing env-based binding) as
 * custom HTTP headers on THIS session's own `event-horizon` server entry, so `ask_user_question`/
 * `permission_prompt`/`propose_board_rebase` route to the right ticket instead of falling back to
 * the `__board__` catch-all. Only applies when the workspace's own event-horizon entry is (or
 * defaults to) the `http` transport — a legacy stdio entry already gets correct per-session env
 * via ordinary child-process inheritance and needs no override here.
 */
function eventHorizonSpawnOverride(conversationId?: string): Record<string, McpServerConfig> {
  if (!conversationId) return {};
  const base = getWorkspaceMcpServers()['event-horizon'];
  if (base && base.type !== 'http') return {}; // stdio (or another transport) — already routed via env inheritance
  // buildMcpServerEntry is the canonical {type, url, alwaysLoad} builder (also used by the
  // installer to write the static workspace .mcp.json this `base` comes from) — reuse it so the
  // URL/port stay correct even if `base` is stale or absent, and layer the header override on top.
  return { 'event-horizon': { ...(base ?? {}), ...buildMcpServerEntry(conversationId) } };
}

function buildModuleMcpConfigArgs(phase?: string, tags?: string[], projectPath?: string, conversationId?: string): string[] {
  const filtered = { ...buildModuleServerMap(phase, tags, projectPath), ...eventHorizonSpawnOverride(conversationId) };
  if (Object.keys(filtered).length === 0) return [];
  return ['--mcp-config', JSON.stringify({ mcpServers: filtered })];
}

// Build the MCP-config args for a spawn, honoring opt-in per-phase server
// profiles (FLUX-490). Default (no `mcpServerPhases` config) is unchanged: merge
// in module servers only, no --strict. When profiles are configured, EH takes
// ownership of the full set — workspace .mcp.json servers ∪ module servers —
// drops any server whose `mcpServerPhases[id]` excludes the current phase, and
// spawns with --strict-mcp-config so Claude Code uses ONLY this set. event-horizon
// is never filtered (agents need ticket tools).
// Pure: drop servers whose `serverPhases[id]` excludes the current phase.
// event-horizon is never dropped. Empty/absent serverPhases → passthrough.
export function filterMcpServersByPhase(
  servers: Record<string, McpServerConfig>,
  serverPhases: Record<string, string[]> | undefined,
  phase?: string,
): Record<string, McpServerConfig> {
  if (!serverPhases || Object.keys(serverPhases).length === 0) return { ...servers };
  const out: Record<string, McpServerConfig> = {};
  for (const [id, cfg] of Object.entries(servers)) {
    const phases = serverPhases[id];
    if (id !== 'event-horizon' && phase && Array.isArray(phases) && phases.length > 0 && !phases.includes(phase)) {
      continue; // scoped to other phases — drop
    }
    out[id] = cfg;
  }
  return out;
}

export function buildSpawnMcpConfigArgs(phase?: string, tags?: string[], projectPath?: string, conversationId?: string): string[] {
  const serverPhases = configCache.mcpServerPhases as Record<string, string[]> | undefined;
  const hasProfiles = !!serverPhases && typeof serverPhases === 'object' && Object.keys(serverPhases).length > 0;
  if (!hasProfiles) return buildModuleMcpConfigArgs(phase, tags, projectPath, conversationId);

  const merged: Record<string, McpServerConfig> = { ...getWorkspaceMcpServers() };
  for (const [id, cfg] of Object.entries(buildModuleServerMap(phase, tags, projectPath))) {
    if (!(id in merged)) merged[id] = cfg;
  }

  const filtered = filterMcpServersByPhase(merged, serverPhases, phase);
  if (!('event-horizon' in filtered)) {
    // Strict mode would strip the agent's OWN ticket tools — e.g. the workspace
    // .mcp.json is missing/malformed so event-horizon never made it into the set.
    // Fail open to merge mode rather than spawn an agent that can't manage the
    // ticket. (Review finding alongside FLUX-490.)
    console.warn('[mcp] strict profile would omit event-horizon — falling back to merge mode');
    return buildModuleMcpConfigArgs(phase, tags, projectPath, conversationId);
  }
  if (Object.keys(filtered).length === 0) return [];
  // FLUX-604: keep the agent's OWN ticket tools loaded directly — no tool-search
  // deferral loop (the orchestrator was re-searching get_ticket ~10x before calling
  // it). Requires Claude Code >= 2.1.121. FLUX-1213: also carry this session's bound
  // conversationId as HTTP headers so its HITL prompts route to its own ticket.
  if (filtered['event-horizon']) {
    filtered['event-horizon'] = {
      ...filtered['event-horizon'],
      alwaysLoad: true,
      ...(conversationId && filtered['event-horizon'].type === 'http'
        ? { headers: { 'x-eh-conversation-id': conversationId, 'x-eh-conversation-token': signConversation(conversationId) } }
        : {}),
    };
  }
  return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: filtered })];
}

// Debug/visibility: which MCP servers would be injected for a given phase, and
// whether strict mode is active. In merge mode the list is only EH-injected
// module servers (.mcp.json/user/global also load, not enumerated). In strict
// mode the list is exactly what the agent gets.
export function getEffectiveSpawnServers(phase?: string, tags?: string[]): { strict: boolean; servers: string[]; note: string } {
  const serverPhases = configCache.mcpServerPhases as Record<string, string[]> | undefined;
  const hasProfiles = !!serverPhases && typeof serverPhases === 'object' && Object.keys(serverPhases).length > 0;
  if (!hasProfiles) {
    return {
      strict: false,
      servers: Object.keys(buildModuleServerMap(phase, tags)),
      note: 'Merge mode: EH-injected module servers only; workspace .mcp.json + user/global servers also load (not listed).',
    };
  }
  const merged: Record<string, McpServerConfig> = { ...getWorkspaceMcpServers() };
  for (const id of Object.keys(buildModuleServerMap(phase, tags))) if (!(id in merged)) merged[id] = {};
  const filtered = filterMcpServersByPhase(merged, serverPhases, phase);
  if (!('event-horizon' in filtered)) {
    // Mirror buildSpawnMcpConfigArgs: strict would strip event-horizon (e.g.
    // .mcp.json missing/malformed) → the real spawn fails open to merge, so the
    // visibility must report merge too, not a misleading "strict".
    return {
      strict: false,
      servers: Object.keys(buildModuleServerMap(phase, tags)),
      note: 'Merge mode (strict profile would omit event-horizon, so the spawn falls back). .mcp.json + user/global servers also load (not listed).',
    };
  }
  return {
    strict: true,
    servers: Object.keys(filtered),
    note: 'Strict mode: exactly the server set the agent gets for this phase (.mcp.json/user/global ignored).',
  };
}

const TOOL_ACTIVITY_MAP: Record<string, string> = {
  Bash: 'Running command',
  Edit: 'Editing',
  Write: 'Editing',
  Read: 'Reading',
  WebFetch: 'Researching',
  WebSearch: 'Researching',
  Agent: 'Delegating',
  TodoWrite: 'Planning',
  publish_artifact: 'Preparing artifact',
  ask_user_question: 'Asking',
  add_note: 'Commenting',
  change_status: 'Updating ticket',
  update_ticket: 'Updating ticket',
  branch: 'Managing branch',
  delegate: 'Delegating',
};

/**
 * FLUX-849: a "dispatched" session is an unattended ticket work session — launched via
 * `start_session`, a board-rebase dispatch, or a portal phase button (Groom / Implement / Review /
 * Finalize) — as opposed to the interactive per-ticket `chat`. A dispatched session runs skip-perm
 * with no human reading the ticket transcript, so its live activity is teed to the board
 * orchestrator thread (`__board__`) where a user watching the board sees `started / working /
 * needs-input / completed / failed` without opening the ticket. Ordinary ticket chats
 * (`phase: 'chat'`) and the board session itself are excluded so the thread isn't flooded by
 * conversations the user is already reading.
 *
 * The gate is the *absence* of a chat — NOT the presence of a work phase. `session.phase` is only
 * populated when the launcher passes one explicitly: `start_session` and board-rebase dispatch
 * forward `phase` only when present (its derivation from ticket status shapes the prompt, never the
 * record), and ad-hoc API launches set none. So requiring a truthy phase would silently no-op the
 * primary agent dispatch path (`start_session` with no explicit phase). An interactive chat always
 * carries `phase: 'chat'`, so any non-board session whose phase is not `'chat'` (including
 * `undefined`) is an unattended dispatch and belongs on the board thread.
 */
function isDispatchedSession(session: CliSessionRecord, taskId: string): boolean {
  return taskId !== BOARD_CONVERSATION_ID && session.phase !== 'chat';
}

/** FLUX-849: short human label for a dispatched session's lifecycle marker on the board chip. */
const DISPATCH_LIFECYCLE_LABEL: Record<Exclude<DispatchLifecycle, 'working'>, string> = {
  started: 'started',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  'waiting-input': 'needs input',
};

/**
 * FLUX-849: tee a dispatched session's live activity to the board orchestrator thread as a quiet
 * `dispatch-activity` note (projected to a non-bubble chip; filtered out of board cold-resume
 * dialogue, so the orchestrator's own working context is untouched). `lifecycle: 'working'` carries
 * an in-flight narration message; the other lifecycles are bracketing markers. Best-effort: a
 * transcript-append or broadcast hiccup must never disturb the session it is narrating.
 */
function teeDispatchActivityToBoard(
  session: CliSessionRecord,
  taskId: string,
  lifecycle: DispatchLifecycle,
  text: string,
): void {
  if (!isDispatchedSession(session, taskId)) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    appendTranscriptEvent(BOARD_CONVERSATION_ID, {
      type: 'dispatch-activity',
      sourceTask: taskId,
      phase: session.phase,
      lifecycle,
      // FLUX-869: carry the session start so the board chip can derive run duration client-side
      // (live-ticking while `working`, final `ran Xm` on terminal rows) without event correlation.
      startedAt: session.startedAt,
      text: trimmed,
      timestamp: new Date().toISOString(),
    });
    broadcastEvent('taskUpdated', { id: BOARD_CONVERSATION_ID });
  } catch (err) {
    // FLUX-862: best-effort (board narration must never break the dispatched session it's
    // narrating), but a persistent failure here was previously completely invisible — log it.
    log.debug(`[teeDispatchActivityToBoard] failed to tee ${lifecycle} for ${taskId}:`, err);
  }
}

/**
 * FLUX-1047: does a CLI terminal-error message describe a CONTEXT-WINDOW overflow (the single session
 * ran out of context), as opposed to a real crash / API error / permission denial? A context overflow is
 * recoverable by re-driving with a FRESH session, so the Furnace stoker retries instead of parking when
 * this matches. Kept a small, exported pure helper so it's unit-testable and reusable by the gemini/
 * copilot adapters later (the durable seam FLUX-996 can build on).
 *
 * CONSERVATIVE by design: a false positive would retry a truly-broken charge (wasting a slot before it
 * eventually parks), so we match only well-known Claude Code / Anthropic context-overflow phrasings and
 * let anything else stay a hard `failed` → park. Explicitly does NOT match the 5-hour/quota usage limit
 * (`rate_limit_event`) — a fresh session doesn't help there, so it's out of scope.
 */
export function isContextExhaustionError(message: string | undefined | null): boolean {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    /prompt is too long/.test(m) ||                       // Anthropic API: "prompt is too long: N tokens > M maximum"
    /context[_ ]length[_ ]exceeded/.test(m) ||            // OpenAI-style code echoed by some tooling
    /context[- ]window/.test(m) && /(exceed|too (long|large)|overflow|full)/.test(m) ||
    /(input|conversation|request).{0,40}exceed.{0,20}context/.test(m) ||
    /maximum context length/.test(m) ||
    /too many tokens/.test(m)
  );
}

/**
 * FLUX-1063: does a CLI terminal-error message describe a usage/RATE-LIMIT exhaustion — the account hit
 * its 5-hour session limit / quota / an HTTP 429 — as opposed to a context overflow or a real crash? This
 * is a TRANSIENT condition: it clears at the provider's reset window, so the Furnace stoker cools the
 * ticket down and auto-retries on a cadence rather than parking it (see furnace-stoker.decideTicketAction).
 *
 * CONSERVATIVE by design, and deliberately DISJOINT from `isContextExhaustionError` (a context overflow is
 * recovered differently — a fresh session, not a cooldown). Matches the well-known Claude Code / Anthropic
 * usage-limit phrasings; the caller additionally treats an explicit HTTP 429 (`api_error_status`) as a
 * rate limit. Anything else stays a hard `failed` → park.
 */
export function isRateLimitError(message: string | undefined | null): boolean {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    /rate[-_ ]?limit/.test(m) ||                          // "rate limit", "rate_limit_event", "rate-limited"
    /usage limit/.test(m) ||                              // Anthropic: "usage limit reached"
    /session limit/.test(m) ||                            // Claude Code: "You've hit your session limit"
    /\b429\b/.test(m) ||                                  // HTTP 429 echoed into the message
    /too many requests/.test(m) ||                        // HTTP 429 canonical text
    /quota (?:exceeded|reached|exhausted|limit)/.test(m) || // API quota — scoped so a bare "disk quota"/"quota config" doesn't false-positive
    /\boverloaded\b/.test(m)                              // Anthropic 529-style transient overload
  );
}

/** Claude Code `--output-format stream-json` content block (`assistant`/`user` message content[]). */
interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

/** One line of Claude Code's `--output-format stream-json` JSONL — the shape this adapter parses.
 *  Fields are a union of every event `type` Claude emits; only the ones this parser reads. */
interface ClaudeCliEvent {
  type?: string;
  session_id?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; name?: string };
  };
  rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number };
  message?: { content?: ClaudeContentBlock[] };
  usage?: {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
  is_error?: boolean;
  error?: string;
  subtype?: string;
  api_error_status?: number;
  result?: string;
  tool_name?: string;
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  // FLUX-932: the line-buffer / JSON.parse / commitPendingAssistantText transport skeleton now lives
  // in shared.ts (sharedAttachStdoutProcessing). This supplies Claude's per-CLI parser: `stream_event`
  // token deltas (--include-partial-messages) + complete `assistant` content[] blocks + `result` usage.
  // narrationType is omitted → Claude flushes compact progress rows (not the 'text' Narration block).
  return sharedAttachStdoutProcessing<ClaudeCliEvent>(proc, session, {
    onEvent: (evt, trimmed, commitPendingAssistantText) => {
        if (!session.resumeSessionId && evt.session_id) {
          session.resumeSessionId = evt.session_id;
        }
        // FLUX-691: token-by-token live streaming. With `--include-partial-messages` the CLI
        // emits `stream_event` lines wrapping the raw Anthropic SSE events. Surface text deltas
        // as a lightweight `assistantDelta` SSE for the live chat node, then STOP: partial events
        // must NOT be teed to the durable transcript (it stays complete-messages-only, so the
        // taskUpdated/progress-driven refetch path is untouched) and must NOT touch the output
        // buffers (the complete `assistant` message — handled below — still owns those).
        if (evt.type === 'stream_event') {
          const inner = evt.event;
          if (inner?.type === 'content_block_delta'
            && inner.delta?.type === 'text_delta'
            && typeof inner.delta.text === 'string'
            && inner.delta.text) {
            broadcastEvent('assistantDelta', {
              taskId,
              sessionId: session.sessionHistoryEntry?.sessionId,
              text: inner.delta.text,
            });
          } else if (inner?.type === 'content_block_start'
            && inner.content_block?.type === 'tool_use'
            && typeof inner.content_block.name === 'string') {
            // FLUX-927: a tool_use block's name arrives up front, BEFORE its (potentially
            // huge) input_json_delta streams — e.g. publish_artifact streams an entire
            // self-contained HTML document as its input. Without this, currentActivity is
            // only set when the COMPLETE assistant message lands (below), so the long
            // input-streaming window shows no signal and the chat feels frozen. Broadcast an
            // early activity the moment the tool name is known so the UI reflects it
            // immediately. (Still partial-only: don't tee the transcript or touch buffers.)
            const name = inner.content_block.name;
            const earlyActivity = name === 'publish_artifact'
              // Generic label: at stream-start the input hasn't arrived, so we can't yet tell a
              // grooming artifact from a Ready-time visual recap (FLUX-976) — don't presume grooming.
              ? 'Preparing artifact…'
              : activityFor(TOOL_ACTIVITY_MAP, name);
            if (session.currentActivity !== earlyActivity) {
              session.currentActivity = earlyActivity;
              session.lastProgressLog = undefined;
              broadcastEvent('activity', { taskId, activity: session.currentActivity });
            }
          }
          return; // FLUX-932: was `continue` — now a return from onEvent (the loop lives in shared.ts).
        }
        // FLUX-981: surface a real rate-limit throttle inline. Gate on the TOP-LEVEL
        // `rate_limit_info.status` (e.g. anything other than 'allowed'), NOT `overageStatus` —
        // a normal request carries `{status:'allowed', overageStatus:'rejected'}`, so gating on
        // overageStatus would false-positive on every request. Note only; does not stop the session.
        if (evt.type === 'rate_limit_event') {
          const info = evt.rate_limit_info || {};
          if (info.status && info.status !== 'allowed') {
            // De-dup: the stream re-emits this event on every retry/backoff while throttled, so
            // surface ONE ⚠️ line per distinct throttle state instead of flooding the chat.
            const key = `${info.status}:${info.rateLimitType ?? ''}`;
            if (session.lastRateLimitKey !== key) {
              session.lastRateLimitKey = key;
              // Number.isFinite (not typeof === 'number') so a NaN resetsAt doesn't reach
              // new Date(NaN).toISOString() — which throws and reroutes the whole line to onParseError.
              const resetsAtRaw = info.resetsAt;
              const resetsAt = typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw)
                ? ` (resets at ${new Date(resetsAtRaw * 1000).toISOString()})`
                : '';
              appendErrorToSession(session, `Rate limited: ${info.status}${info.rateLimitType ? ` [${info.rateLimitType}]` : ''}${resetsAt}`);
            }
          } else if (session.lastRateLimitKey) {
            // Back to allowed — reset so a later re-throttle surfaces again.
            session.lastRateLimitKey = undefined;
          }
          // FLUX-602: still tee the raw line to the durable transcript (the early return here used to
          // skip it, silently dropping every rate_limit_event — including normal `allowed` ones —
          // from the per-ticket transcript). Tee, THEN return.
          appendTranscriptLine(taskId, trimmed);
          return;
        }
        // FLUX-602: tee every raw stream-json line to the durable per-ticket transcript.
        appendTranscriptLine(taskId, trimmed);
        // FLUX-981: surface individual tool-result errors inline. Claude delivers tool RESULTS as
        // `user` messages whose content blocks carry `is_error` — previously never inspected, so a
        // failed Bash/Edit/etc. mid-session was silently dropped (only a terminal result.is_error or
        // a nonzero process exit ever surfaced). Copilot/Gemini already do this via appendErrorToSession.
        if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block?.type === 'tool_result' && block.is_error) {
              const toolName = (block.tool_use_id && session.toolNamesById?.[block.tool_use_id]) || 'unknown';
              const raw = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ')
                  : '';
              const detail = raw.trim().slice(0, 200);
              appendErrorToSession(session, `Tool failed: ${toolName}${detail ? ` — ${detail}` : ''}`);
            }
          }
        }
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          const toolBlock = evt.message.content.find((b) => b.type === 'tool_use');
          if (toolBlock) {
            session.pendingAssistantText = '';
            const newActivity = activityFor(TOOL_ACTIVITY_MAP, toolBlock.name ?? '');
            const activityChanged = session.currentActivity !== newActivity;
            session.currentActivity = newActivity;

            // Reset last progress log when activity changes
            if (activityChanged) {
              session.lastProgressLog = undefined;
            }

            // Log progress when activity changes or for significant tools
            if (activityChanged && session.sessionHistoryEntry?.sessionId) {
              const toolName = toolBlock.name;
              let progressMsg = session.currentActivity;

              // Add context for specific tools if available
              if (toolBlock.input) {
                if (toolName === 'Read' && typeof toolBlock.input.file_path === 'string') {
                  progressMsg = `Reading ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Edit' && typeof toolBlock.input.file_path === 'string') {
                  progressMsg = `Editing ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Write' && typeof toolBlock.input.file_path === 'string') {
                  progressMsg = `Writing ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Bash' && toolBlock.input.command) {
                  const cmd = String(toolBlock.input.command).slice(0, 50);
                  progressMsg = `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
                }
              }

              // Accumulate tool progress in memory only — written to file at session end
              if (session.sessionHistoryEntry) {
                session.sessionHistoryEntry.progress.push({
                  timestamp: new Date().toISOString(),
                  message: progressMsg,
                  type: 'tool',
                  data: { toolName, parameters: toolBlock.input }
                });
              }
            }
          } else {
            commitPendingAssistantText();
            session.currentActivity = 'Thinking';
          }
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
          for (const block of evt.message.content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              session.liveOutputBuffer += block.text;
              if (!toolBlock) {
                session.pendingAssistantText += block.text;
              }
            } else if (block.type === 'tool_use' && block.id && typeof block.name === 'string') {
              // FLUX-981: remember id→name so a later `user` tool_result carrying is_error can be
              // labeled with the tool that failed (the result block carries only tool_use_id).
              (session.toolNamesById ??= {})[block.id] = block.name;
            }
          }
        } else {
          if (evt.type !== 'tool_use' && evt.type !== 'tool_result') {
            commitPendingAssistantText();
          } else {
            session.pendingAssistantText = '';
          }
          appendSessionOutput(session, trimmed, 'stdout', false);
        }
        if (evt.type === 'result') {
          session.currentActivity = undefined;
          session.toolNamesById = undefined; // FLUX-981: turn ended — release the id→name map.
          broadcastEvent('activity', { taskId, activity: null });
        }
        if (evt.type === 'result' && evt.usage) {
          const cacheRead = evt.usage?.cache_read_input_tokens ?? 0;
          const cacheCreation = evt.usage?.cache_creation_input_tokens ?? 0;
          const freshInput = evt.usage?.input_tokens ?? 0;
          const inputTok = freshInput + cacheRead + cacheCreation;
          const outputTok = evt.usage?.output_tokens ?? 0;
          session.inputTokens = (session.inputTokens ?? 0) + inputTok;
          session.outputTokens = (session.outputTokens ?? 0) + outputTok;
          session.cacheReadTokens = (session.cacheReadTokens ?? 0) + cacheRead;
          session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + cacheCreation;
          if (typeof evt.total_cost_usd === 'number') {
            session.costUSD = (session.costUSD ?? 0) + evt.total_cost_usd;
          } else {
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.resumeSessionId, inputTok, outputTok);
            session.costIsEstimated = true;
          }
        }
        if (evt.type === 'tool_use_blocked' || (evt.type === 'result' && evt.is_error && /permission|not allowed|denied/i.test(String(evt.error || '')))) {
          const reason = evt.tool_name
            ? `Blocked: ${evt.tool_name}${evt.error ? ` — ${evt.error}` : ''}`
            : String(evt.error || 'Permission denied');
          session.blockedReason = reason;
          session.status = 'waiting-input';
          flushSessionOutput(session, true);
          enqueueSessionWrite(session, async () => {
            await updateTaskWithHistory(taskId, {
              updatedBy: 'Agent',
              nextStatus: configCache.requireInputStatus || 'Require Input',
              entries: [buildActivityEntry(`${session.label} blocked: ${reason}`, 'Agent', new Date().toISOString())],
            });
          });
        } else if (evt.type === 'result' && evt.is_error) {
          // FLUX-981: a non-permission result error (API error, overload, invalid request) was
          // previously DROPPED — it doesn't match the permission regex above and there's no other
          // handler, so it fell silently into liveOutputBuffer. Surface it inline. Do NOT flip to
          // waiting-input: this isn't a HITL prompt, and the exit handler still runs afterward.
          const errText = String(evt.error || evt.subtype || 'unknown');
          appendErrorToSession(session, `Agent error: ${errText}`);
          // FLUX-1047 / FLUX-1063: classify a RECOVERABLE terminal cause here — the only reliable point,
          // since the exit funnel only sees an opaque nonzero code by the time this surfaces. Stamp the
          // structured terminalReason BEFORE the exit funnel flips status to 'failed', so the Furnace
          // stoker can read it and recover (fresh session / cooldown) instead of parking on the first
          // strike. A rate limit hides in `result` + `api_error_status` (not `error`/`subtype`): the
          // 5-hour-limit payload is `{is_error:true, subtype:"success", api_error_status:429,
          // result:"You've hit your session limit …"}`, so `errText` alone is just "success".
          const resultText = typeof evt.result === 'string' ? evt.result : '';
          const combined = `${errText} ${resultText}`;
          if (isContextExhaustionError(combined)) {
            session.terminalReason = 'context-exhausted';
          } else if (evt.api_error_status === 429 || isRateLimitError(combined)) {
            session.terminalReason = 'rate-limited';
          }
        }
    },
    onParseError: (trimmed) => {
      appendSessionOutput(session, trimmed, 'stdout', false);
    },
  });
}

// FLUX-604: per-conversation --model/--effort args from the chat picker, read off
// the session record. `defaultEffort` applies only when the user hasn't picked one.
export function modelEffortArgs(session: CliSessionRecord, defaultEffort?: string): string[] {
  const args: string[] = [];
  if (session.model) args.push('--model', session.model);
  const picked = session.effortOverride && (EFFORT_LEVELS as readonly string[]).includes(session.effortOverride)
    ? session.effortOverride
    : defaultEffort;
  if (picked) args.push('--effort', picked);
  return args;
}

// FLUX-605: permission flag per session. 'gated' routes tool decisions through the EH
// permission_prompt MCP tool; 'skip' (or legacy skipPermissions) uses
// --dangerously-skip-permissions. Mutually exclusive.
export function permissionArgs(session: CliSessionRecord): string[] {
  if (session.permissionMode === 'gated') return ['--permission-prompt-tool', 'mcp__event-horizon__permission_prompt'];
  if (session.permissionMode === 'skip' || session.skipPermissions) return ['--dangerously-skip-permissions'];
  return [];
}

// FLUX-662: the native AskUserQuestion tool can't be fulfilled in `claude -p` print mode (no
// interactive TTY surface — the harness silently denies it, degrading the agent to prose).
// Disallow it everywhere so it can never be reached; agents ask via the event-horizon
// `ask_user_question` MCP tool instead, which surfaces a real portal picker. (Flag verified
// against the installed CLI: `--disallowedTools, --disallowed-tools <tools...>`.)
export const DISALLOW_NATIVE_ASK = ['--disallowed-tools', 'AskUserQuestion'];

// FLUX-926: ticket chat may edit files only while the ticket is In Progress —
// grooming/discussion turns should not silently mutate the repo. Dispatched
// implementation/grooming/review/finalize sessions and the board session are unaffected
// (phase-scoped to 'chat'). --disallowed-tools is permission-mode-independent, so this covers
// the default 'skip' chat path where permission_prompt never fires.
//
// FLUX-1123: this enforcement mechanism (`--disallowed-tools`) is Claude-Code-only — neither the
// Copilot nor the Gemini CLI exposes an equivalent per-tool disallow flag (confirmed against both
// live CLIs; see the FLUX-959 comments atop copilot-board.ts / gemini-board.ts). A workspace whose
// default chat framework is Copilot or Gemini gets only the best-effort prompt note
// (`chatEditGateNote` in shared.ts, wired into copilot.ts/gemini.ts) — a real block, not a request,
// exists only here. See CLI_CAPABILITIES.chatEditGateEnforced.
export const FILE_MUTATION_TOOLS = [
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  // Known MCP file editors (Serena). Best-effort — --disallowed-tools is name-based, so a new
  // file-writing MCP tool isn't covered automatically until added here.
  'mcp__serena__replace_symbol_body', 'mcp__serena__insert_after_symbol',
  'mcp__serena__insert_before_symbol', 'mcp__serena__replace_content',
  'mcp__serena__rename_symbol', 'mcp__serena__safe_delete_symbol',
];

// FLUX-1123: `isChatEditGated` now lives in shared.ts so copilot.ts/gemini.ts can share the same
// gating decision (framework-agnostic — reads only session.phase/task.status). Re-exported here
// since this is where Claude's own enforcement (disallowedToolsArgs below) and the existing test
// import live.
export { isChatEditGated };

export function disallowedToolsArgs(session: { phase?: CliSessionRecord['phase'] | undefined }, task: { status?: string | undefined } | undefined): string[] {
  const tools = ['AskUserQuestion'];
  if (isChatEditGated(session, task)) tools.push(...FILE_MUTATION_TOOLS);
  return ['--disallowed-tools', ...tools];
}

export async function startCliSession(session: CliSessionRecord, task: ClaudeTask, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const framework = session.framework;
  const binaryName = framework === 'claude' ? 'claude' : 'copilot';
  const label = session.label;
  const id = session.taskId;
  // FLUX-519: run the agent in this task's worktree when one exists (else engine root).
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot);
  session.executionRoot = executionRoot;

  // FLUX-1018 / FLUX-1028: fail closed on the fresh-spawn path (shared helper —
  // see assertIsolatedSpawnRoot in task-worktree.ts).
  assertIsolatedSpawnRoot(binaryName, id, task, executionRoot, workspaceRoot);

  await checkBinaryInstalled(binaryName);

  const claudeIntegration = configCache.integrations?.claudeCode;
  const groomingStatuses = [configCache.requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = claudeIntegration && framework === 'claude'
    ? (groomingStatuses.includes(task.status) ? claudeIntegration.groomingModel : claudeIntegration.implementationModel)
    : null;

  const initialPrompt = buildInitialPrompt(task, appendPrompt, { diffBlock: session.diffBlock, phase: session.phase, framework: 'claude', editsGated: isChatEditGated(session, task) });

  // FLUX-579: ensure this session's per-worktree shared HTTP server(s) exist (keyed
  // by execution root) before building the MCP config that looks them up.
  const sessionTags = Array.isArray(task.tags) ? task.tags : undefined;
  if (framework === 'claude') await ensureSharedServersForRoot(executionRoot, session.phase, sessionTags);

  const modelToUse = session.model || selectedModel;
  const claudeArgs = [
    ...(modelToUse ? ['--model', modelToUse] : []),
    '-p', initialPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    // FLUX-691: emit partial assistant deltas for token-by-token live streaming in the chat.
    '--include-partial-messages',
    ...disallowedToolsArgs(session, task),
    ...permissionArgs(session),
    // Multi-repo group: put every checked-out member repo in scope (no-op single-repo).
    ...buildMemberScopeArgs(),
    // Member worktree: add local .flux-group/ so the agent reads shared group docs (FLUX-422).
    ...buildGroupDocsScopeArg(workspaceRoot),
    // Inject enabled module MCP servers dynamically (phase+tag gated, skips errored probes).
    ...(framework === 'claude' ? buildSpawnMcpConfigArgs(session.phase, sessionTags, executionRoot, id) : []),
  ];

  const effortCap = CLI_CAPABILITIES[framework].effort;
  const globalEffort = configCache.effortLevel as string | undefined;
  const taskEffort = task.effortLevel;
  const effectiveEffort = (session.effortOverride || effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (effortCap.supported && effortCap.flag && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    claudeArgs.push(effortCap.flag, effectiveEffort);
  }

  // S9 (epic FLUX-996): telemetry for this spawn — cmd deliberately omits the full `-p` prompt
  // (arbitrary-size user/ticket content, not itself a credential, but not fit for a telemetry
  // buffer/SSE broadcast either).
  const spawnStartedAt = Date.now();
  const spawnCmd = `${binaryName}${modelToUse ? ` --model ${modelToUse}` : ''} (spawn)`;
  // FLUX-1109: 'error' and 'exit' can BOTH fire for one failed spawn (Node's own child_process
  // docs warn about this) — guard so only the first to fire records telemetry, not two events
  // double-counting one failure in the ring buffer/SSE stream.
  let telemetryEmitted = false;
  let proc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    // The npm bin wrapper is a bash script that execs claude.exe
    // Direct spawn of .exe preserves stdio streams for JSON output
    // FLUX-975: resolveClaudeExePath caches the result across every spawn (start + resume,
    // per-ticket + board) instead of re-running `npm prefix -g` on each one.
    const exePath = await resolveClaudeExePath();

    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }

    log.info(`[${id}] Windows spawn: ${exePath} with ${claudeArgs.length} args`);
    log.info(`[${id}] Prompt length: ${initialPrompt.length} chars`);
    proc = spawn(exePath, claudeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv('claude', id),
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    proc = spawn(binaryName, claudeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv('claude', id),
      stdio: 'pipe',
    });
  }
  session.proc = proc as ChildProcessWithoutNullStreams;
  session.pid = proc.pid;
  session.status = 'running';
  session.args = claudeArgs;
  // FLUX-651: snapshot the ticket state at turn start; clear any stale "parked" flag now that
  // work is (re)starting so the board stops showing Needs Action mid-turn.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  // FLUX-849: announce a dispatched session's start on the board orchestrator thread so a user
  // watching the board sees it spin up without opening the ticket (no-op for interactive chats).
  teeDispatchActivityToBoard(session, id, 'started', `${session.phase ?? 'work'} session started`);

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  proc.on('error', async (error) => {
    // Node can fire both 'error' and 'exit' for one failed spawn — guard raiseNeedsAction on
    // whether THIS handler is the first to observe the spawn's outcome (mirrors the 'exit'
    // handler below), so a healthy 'exit' that already ran first can't be overridden by a
    // spurious later 'error' flagging a ticket that actually succeeded.
    const isFirstOutcome = !telemetryEmitted;
    if (!telemetryEmitted) {
      telemetryEmitted = true;
      emitOperationEvent({
        kind: 'spawn',
        ticketId: id,
        sessionId: session.id,
        cmd: spawnCmd,
        startedAt: spawnStartedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - spawnStartedAt,
        outcome: 'error',
        reason: error.message,
      });
    }
    // Clear heartbeat timer
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    commitPending();
    // FLUX-981: surface the spawn failure inline in the chat, not only as a history activity entry.
    appendErrorToSession(session, `Failed to start agent: ${error.message}`);
    flushSessionOutput(session, true);
    await session.writeQueue;

    const outcome = `${label} session failed to start: ${error.message}`;
    // S10 (epic FLUX-996): a spawn that never got going is otherwise invisible on the board — no
    // session ever ran to trip the parked-turn backstop. Raise it directly via the same
    // needsAction + notification plumbing so it surfaces even when nobody is watching this ticket.
    if (isFirstOutcome) void raiseNeedsAction(id, `Failed to start agent: ${error.message}`);

    // FLUX-849: a spawn failure after the 'started' tee would otherwise leave the board chip
    // dangling — bracket it with a terminal 'failed' marker so the lifecycle is symmetric.
    teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);

    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = 'failed';
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        sessionEntry.progress = accumulatedProgress;
      });
    } else {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
      });
    }

    console.error(`[${id}] Failed to spawn ${binaryName}:`, error.message);
  });

  // Create agent_session history entry
  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label, {
    groupId: session.groupId,
    role: session.role,
    pattern: session.groupType,
  });
  session.sessionHistoryEntry = sessionEntry;

  await updateTaskWithHistory(id, {
    updatedBy: 'Agent',
    entries: [sessionEntry],
  });

  // Start progress heartbeat - accumulate activity in memory every 15 seconds
  session.progressHeartbeat = setInterval(() => {
    if (session.currentActivity && session.sessionHistoryEntry) {
      const now = new Date().toISOString();
      // Only log if we haven't logged this same activity recently
      if (session.lastProgressLog !== session.currentActivity) {
        session.lastProgressLog = session.currentActivity;
        // Accumulate in memory only — written to file when session ends
        session.sessionHistoryEntry.progress.push({
          timestamp: now,
          message: session.currentActivity,
          type: 'info',
        });
      }
    }
  }, 15000);

  proc.on('exit', async (code, signal) => {
    // FLUX-1207: best-effort reap of any orphaned descendants (e.g. a Bash-tool-launched vitest
    // run) on every exit, not only engine-initiated stop().
    killProcessTree(proc, undefined, { label: id });
    if (!telemetryEmitted) {
      telemetryEmitted = true;
      const spawnEndedAt = Date.now();
      // FLUX-1109: a Require-Input pause is a healthy, non-failure outcome regardless of exit
      // code (mirrors how the rest of this handler already branches on pausedForInput below) —
      // consult it here too so telemetry doesn't mislabel a normal HITL pause as 'error'.
      const outcome: OperationOutcome = session.requestedStop
        ? 'aborted'
        : session.pausedForInput || code === 0
          ? 'ok'
          : 'error';
      emitOperationEvent({
        kind: 'spawn',
        ticketId: id,
        sessionId: session.id,
        cmd: spawnCmd,
        startedAt: spawnStartedAt,
        endedAt: spawnEndedAt,
        durationMs: spawnEndedAt - spawnStartedAt,
        outcome,
        reason: session.requestedStop ? 'stopped by user' : outcome === 'error' ? (signal ? `signal ${signal}` : `exit code ${code}`) : undefined,
      });
      // S10 (epic FLUX-996): surface a crashed spawn (non-zero/signalled exit, not a user stop or
      // a healthy Require-Input pause) via the same needsAction + notification plumbing used
      // elsewhere — this session never reaches the parked-turn backstop (it never really started).
      if (outcome === 'error') {
        void raiseNeedsAction(id, `Agent process exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`}).`);
      }
    }
    // Clear heartbeat timer
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    commitPending();
    flushSessionOutput(session, true);
    await session.writeQueue;

    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'waiting-input';
    if (session.requestedStop) {
      session.endedAt = new Date().toISOString();
      session.status = 'cancelled';
      finalStatus = 'cancelled';
    } else if (session.pausedForInput) {
      // Agent moved ticket to Require Input and was told to stop — stay resumable.
      // Do NOT set endedAt — session is still alive, waiting for user reply.
      finalStatus = 'waiting-input';
    } else if (code === 0) {
      if (session.phase === 'chat') {
        // FLUX-602: per-ticket chat is a persistent conversation — a finished turn
        // stays resumable (waiting-input) instead of going terminal, so the next
        // message --resumes the same session (one session, one history entry,
        // full memory) rather than spawning a fresh, amnesiac one.
        session.status = 'waiting-input';
        finalStatus = 'waiting-input';
      } else {
        session.endedAt = new Date().toISOString();
        session.status = 'completed';
        finalStatus = 'completed';
      }
    } else {
      session.endedAt = new Date().toISOString();
      session.status = 'failed';
      finalStatus = 'failed';
    }

    // Paused for user input — session stays alive and resumable. Flush tokens
    // but do NOT mark as terminal, notify barriers, or log an "ended" activity.
    if (finalStatus === 'waiting-input') {
      const tokenUpdate = (session.inputTokens ?? 0) > 0 || (session.outputTokens ?? 0) > 0
        ? (() => {
            const prev = tasksCache[id]?.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
            return {
              inputTokens: (prev.inputTokens ?? 0) + (session.inputTokens ?? 0),
              outputTokens: (prev.outputTokens ?? 0) + (session.outputTokens ?? 0),
              costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
              costIsEstimated: prev.costIsEstimated || session.costIsEstimated || false,
              cacheReadTokens: (prev.cacheReadTokens ?? 0) + (session.cacheReadTokens ?? 0),
              cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (session.cacheCreationTokens ?? 0),
            };
          })()
        : null;
      if (tokenUpdate) {
        await updateTaskWithHistory(id, { updatedBy: 'Agent', entries: [], tokenMetadata: tokenUpdate });
      }
      const pausedHistoryEntry = session.sessionHistoryEntry;
      if (pausedHistoryEntry?.sessionId) {
        await updateAgentSession(id, pausedHistoryEntry.sessionId, (sessionEntry) => {
          sessionEntry.status = 'waiting-input';
          sessionEntry.outcome = `${label} paused — waiting for user input.`;
          sessionEntry.progress = pausedHistoryEntry.progress || [];
        });
      }
      // FLUX-651: a chat turn that ends without the agent moving the ticket = "sat on its
      // hands". Don't flag a turn the agent itself paused for Require Input (pausedForInput).
      if (!session.pausedForInput) await flagIfParked(session, id);
      // FLUX-849: a dispatched session paused for input — mark it on the board thread.
      teeDispatchActivityToBoard(session, id, 'waiting-input', DISPATCH_LIFECYCLE_LABEL['waiting-input']);
      broadcastEvent('taskUpdated', { id });
      return;
    }

    const outcome = session.requestedStop
      ? `${label} session stopped by user.`
      : `${label} session ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;

    // FLUX-981: a nonzero/signal exit that the user did NOT cancel surfaces inline in the chat, in
    // addition to the outcome/activity record below. `finalStatus` is 'failed' ONLY for a genuine
    // failure — requestedStop maps to 'cancelled' and pausedForInput returned above — so this keeps
    // the cancelled-guard: a user-stopped session is never reported as an error. Await the write
    // queue so the injected ⚠️ line lands in progress[] before it's snapshotted below.
    if (finalStatus === 'failed') {
      const stderrHint = session.stderrCapture?.trim();
      const fullMessage = stderrHint ? `${outcome}\n${stderrHint}` : outcome;
      appendErrorToSession(session, fullMessage);
      await session.writeQueue;
    }

    // FLUX-849: bracket the dispatched session's board narration with a terminal marker.
    // `finalStatus` here is one of completed / failed / cancelled (waiting-input returns above).
    teeDispatchActivityToBoard(session, id, finalStatus, DISPATCH_LIFECYCLE_LABEL[finalStatus]);

    const tokenUpdate = (session.inputTokens ?? 0) > 0 || (session.outputTokens ?? 0) > 0
      ? (() => {
          const prev = tasksCache[id]?.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
          return {
            inputTokens: (prev.inputTokens ?? 0) + (session.inputTokens ?? 0),
            outputTokens: (prev.outputTokens ?? 0) + (session.outputTokens ?? 0),
            costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
            costIsEstimated: prev.costIsEstimated || session.costIsEstimated || false,
            cacheReadTokens: (prev.cacheReadTokens ?? 0) + (session.cacheReadTokens ?? 0),
            cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (session.cacheCreationTokens ?? 0),
          };
        })()
      : null;

    // Close the session entry with outcome and flush accumulated progress
    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = finalStatus;
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        // Merge in-memory progress accumulated during the session
        sessionEntry.progress = accumulatedProgress;
      });

      // Save the agent's final message as a comment on the ticket
      const textEntries = accumulatedProgress.filter((p) => p.type === 'text' && p.message?.trim());
      const lastText = textEntries.length > 0 ? textEntries[textEntries.length - 1]?.message : '';
      if (lastText && finalStatus === 'completed') {
        const maxCommentLen = 3000;
        const commentBody = lastText.length > maxCommentLen ? lastText.slice(0, maxCommentLen) + '...' : lastText;
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [buildCommentEntry(label, commentBody, session.endedAt!)],
          tokenMetadata: tokenUpdate ?? undefined,
        });
      } else if (tokenUpdate) {
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [],
          tokenMetadata: tokenUpdate,
        });
      }
    } else {
      // Fallback to old behavior
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt!)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }

    if (finalStatus === 'completed') {
      checkFrameworkHealth(session.framework).catch(() => {});
      checkSkillStaleness(session.framework).catch(() => {});
      // FLUX-651: a phase session that ended cleanly but left the ticket in a working status
      // without taking a board action gets flagged Needs Action (surface, don't auto-resume).
      await flagIfParked(session, id);
    }

    // Notify delegation awaiters (supervisor pattern).
    notifyDelegationComplete(session);

    // Fan-in: if this session belongs to a run group, a deferred combiner may
    // be waiting for every worker to finish. Notify the barrier.
    if (session.groupId) {
      notifyGroupSessionTerminal(session.taskId, session.groupId).catch(() => {});
    }

    checkAutoRestart();
  });}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'claude-code',
    displayName: 'Claude Code',
    configSchema: {},
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Claude Code';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    return startCliSession(session, task as ClaudeTask, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot, opts);
  }

  stop(session: CliSessionRecord): void {
    // Tree-kill so the agent's MCP servers (serena, context7, …) are reaped too, not orphaned —
    // the stale-node-process leak. See kill-process-tree.ts.
    killProcessTree(session.proc);
  }
}

export async function sendCliSessionInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions) {
  const id = session.taskId;
  const binaryName = session.command;
  // FLUX-519 review: resume in the SAME root the session started in; refuse to fall
  // back onto master if the worktree was removed (e.g. the ticket was finished).
  // FLUX-1018 / FLUX-1028: shared fail-closed guard — see resolveResumeExecutionRoot
  // in task-worktree.ts. FLUX-1120: this throws BEFORE any child process spawns, so
  // surface it the same way a spawn failure is surfaced instead of letting it vanish
  // into an HTTP-500-only response — see surfaceResumeFailure in shared.ts.
  let executionRoot: string;
  try {
    executionRoot = await resolveResumeExecutionRoot(session, tasksCache[id], workspaceRoot);
  } catch (error) {
    // FLUX-1182: bracket this with the same board narration the other resumed-turn failure
    // paths get (reply spawn-error / reply-exit crash, below) — a board-dispatched session
    // whose worktree was reclaimed otherwise surfaces via raiseNeedsAction + the ticket chat
    // but leaves no 'failed' chip in the orchestrator thread.
    teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);
    return surfaceResumeFailure(session, id, error);
  }

  await checkBinaryInstalled(binaryName);

  const inputAt = new Date().toISOString();
  // FLUX-655: "since you last spoke" basis for the resume preamble — captured BEFORE we overwrite
  // lastInputAt below, so it reflects the PRIOR turn (last agent output, else last user input).
  const sinceIso = session.lastOutputAt ?? session.lastInputAt;
  session.lastInputAt = inputAt;
  session.status = 'running';
  session.pausedForInput = false;
  // FLUX-915: clear a stale stop flag from a prior turn so this resumed turn isn't mis-terminalized
  // as 'cancelled' by the exit handler. requestedStop is set on stop but never otherwise reset, and
  // this record is reused across turns (persistent chat / dispatched session).
  session.requestedStop = false;
  // FLUX-909: new turn started — clear the stale block reason from a prior parked turn so the
  // card no longer reads as amber "Needs your input" after the user has answered and the agent
  // resumes. blockedReason is set on the block path but otherwise never cleared.
  delete session.blockedReason;
  // FLUX-651: new turn — snapshot ticket state and drop any stale "parked" flag.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  // FLUX-674: pasted-image attachments for this turn. Resolve to absolute sidecar paths the
  // agent can Read; keep the metadata for the durable transcript so the bubble re-renders.
  const attachments = opts?.attachments ?? [];
  const attachmentAbsPaths = resolveAttachmentAbsPaths(attachments);

  const task = tasksCache[id] as ClaudeTask;

  // FLUX-655: on a RESUMED turn, re-ground the agent in the moved tree. If the world actually
  // changed (branch fell behind, master rewrote files underneath us, sibling tickets merged), build
  // a compact situational update to prepend to the prompt below. Computed BEFORE the user event is
  // recorded so the `resume-preamble` transcript event is ordered ahead of the `user` event for this
  // turn (FLUX-716 item 3). Fully best-effort: a null assemble (no delta / git hiccup) is a no-op.
  let resumePreamble: string | null = null;
  if (session.resumeSessionId) {
    resumePreamble = await buildResumePreamble({
      taskId: id,
      branch: typeof task?.branch === 'string' ? task.branch : undefined,
      workspaceRoot: canonicalWorkspaceRoot ?? workspaceRoot,
      sinceIso,
    });
    if (resumePreamble) {
      appendTranscriptEvent(id, { type: 'resume-preamble', text: resumePreamble, timestamp: inputAt });
    }
  }

  // FLUX-602: record the user's turn in the durable transcript (raw tier). The image refs ride
  // on the turn (FLUX-674) so a reload / cold resume re-presents them.
  appendTranscriptEvent(id, { type: 'user', text: message, attachments, timestamp: inputAt });

  // History comment shows the user's words plus a note of any attached files.
  const fileNote = attachments.length
    ? `\n\n📎 ${attachments.map((a) => a.fileName || 'image').join(', ')}`
    : '';
  const historyComment = `${message}${fileNote}`.trim();
  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, historyComment, inputAt)],
  });

  // Effective prompt to the CLI = the user's text + a Read-the-image instruction (FLUX-674).
  const safeMessage = `${message.replace(/\0/g, '')}${attachmentReadInstruction(attachmentAbsPaths)}`;
  const memberScopeArgs = [...buildMemberScopeArgs(), ...buildGroupDocsScopeArg(workspaceRoot)];

  // FLUX-655: prepend the situational update (computed above) to the prompt sent to the CLI. The CLI
  // takes a single `-p` and with --resume there is no separate system channel, so prepending is the
  // mechanism. The preamble is recorded as its OWN durable transcript event above (NOT folded into
  // the user's message — FLUX-716 item 3 orders it before the user event).
  // FLUX-926 / FLUX-1123: same "why is this blocked" note as the initial spawn, recomputed per
  // resumed turn — shared across adapters via prependEditGateNote (framework-aware wording).
  const promptWithGateNote = prependEditGateNote(session, task, 'claude', safeMessage);
  const promptForCli = resumePreamble ? `${resumePreamble}\n\n---\n\n${promptWithGateNote}` : promptWithGateNote;

  // FLUX-579: ensure the per-worktree shared server exists for this resumed turn's
  // execution root before resolving the MCP config (engine may have restarted, or
  // this is the first turn in a freshly-created worktree).
  const resumeTags = Array.isArray(task?.tags) ? task.tags : undefined;
  await ensureSharedServersForRoot(executionRoot, session.phase, resumeTags);
  const moduleMcpArgs = buildSpawnMcpConfigArgs(session.phase, resumeTags, executionRoot, id);
  const meArgs = modelEffortArgs(session);
  // FLUX-691: `--include-partial-messages` → token-by-token live streaming on the resume/send path.
  const resumeArgs = session.resumeSessionId
    ? ['-p', promptForCli, '--resume', session.resumeSessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...meArgs, ...disallowedToolsArgs(session, task), ...permissionArgs(session), ...memberScopeArgs, ...moduleMcpArgs]
    : ['-p', promptForCli, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...meArgs, ...disallowedToolsArgs(session, task), ...permissionArgs(session), ...memberScopeArgs, ...moduleMcpArgs];

  // S9 (epic FLUX-996): telemetry for this resume spawn — see the initial-spawn comment above for
  // why `cmd` omits the full prompt.
  const spawnStartedAt = Date.now();
  const spawnCmd = `${binaryName}${session.model ? ` --model ${session.model}` : ''} (resume)`;
  // FLUX-1109: guard against the 'error'+'exit' double-fire, same as the initial spawn above.
  let telemetryEmitted = false;
  let replyProc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    // FLUX-975: resolveClaudeExePath caches the result across every spawn.
    const exePath = await resolveClaudeExePath();

    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }

    log.info(`[${id}] Windows reply spawn: ${exePath} --resume ${session.resumeSessionId || '(new)'}`);
    replyProc = spawn(exePath, resumeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv('claude', id),
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    replyProc = spawn(binaryName, resumeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv('claude', id),
      stdio: 'pipe',
      windowsHide: true,
    });
  }
  session.proc = replyProc as ChildProcessWithoutNullStreams;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  replyProc.on('error', async (error) => {
    // FLUX-1204: Node can fire both 'error' and 'exit' for one failed spawn — guard
    // raiseNeedsAction on whether THIS handler is the first to observe the outcome (mirrors the
    // initial-spawn path), so a healthy 'exit' that already ran first can't be overridden by a
    // spurious later 'error' flagging a resumed turn that actually succeeded.
    const isFirstOutcome = !telemetryEmitted;
    if (!telemetryEmitted) {
      telemetryEmitted = true;
      emitOperationEvent({
        kind: 'spawn',
        ticketId: id,
        sessionId: session.id,
        cmd: spawnCmd,
        startedAt: spawnStartedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - spawnStartedAt,
        outcome: 'error',
        reason: error.message,
      });
    }
    // FLUX-915/918/921: a stop racing a spawn error stays 'cancelled' rather than reverting to
    // resumable; otherwise flag the crashed reply blocked so the card classifies it "Needs your
    // input" (amber) rather than calm idle — classifyCardSessionState keys off blockedReason.
    terminalizeResumedExit(session, { blockedReason: `Reply failed: ${error.message}` });
    commitReplyPending();
    // FLUX-981: surface the reply spawn failure inline in the chat, not only on the board / as an
    // activity entry. Skip when the user cancelled — a stop that races the spawn error isn't a fault.
    if (!session.requestedStop) {
      appendErrorToSession(session, `Failed to resume agent: ${error.message}`);
      // S10 (epic FLUX-996): same needsAction + notification surfacing as the initial-spawn path.
      // Only raise when this handler is the first to observe the outcome (FLUX-1204).
      if (isFirstOutcome) void raiseNeedsAction(id, `Failed to resume agent: ${error.message}`);
    }
    flushSessionOutput(session, true);
    // FLUX-849: a crashed resumed turn (reply spawn error) was previously invisible on the board —
    // the only tee on this path was the Require-Input pause. Bracket it with a 'failed' marker so a
    // board-watcher sees the crash even though the session itself stays resumable.
    teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    console.error(`[${id}] Failed to spawn ${binaryName} for reply:`, error.message);
  });

  replyProc.on('exit', async (code, signal) => {
    // FLUX-1207: best-effort reap of any orphaned descendants (e.g. a Bash-tool-launched vitest
    // run) on every exit, not only engine-initiated stop().
    killProcessTree(replyProc, undefined, { label: id });
    // FLUX-1204: mirror the initial-spawn path — guard raiseNeedsAction below on whether THIS
    // handler is the first to observe the outcome, so a spurious 'error' that already fired (and
    // raised needsAction) can't be double-counted by a subsequent non-zero/signalled 'exit'.
    const isFirstOutcome = !telemetryEmitted;
    if (!telemetryEmitted) {
      telemetryEmitted = true;
      const spawnEndedAt = Date.now();
      // FLUX-1109: fold pausedForInput into 'ok' — same rationale as the initial spawn above.
      const outcome: OperationOutcome = session.requestedStop
        ? 'aborted'
        : session.pausedForInput || code === 0
          ? 'ok'
          : 'error';
      emitOperationEvent({
        kind: 'spawn',
        ticketId: id,
        sessionId: session.id,
        cmd: spawnCmd,
        startedAt: spawnStartedAt,
        endedAt: spawnEndedAt,
        durationMs: spawnEndedAt - spawnStartedAt,
        outcome,
        reason: session.requestedStop ? 'stopped by user' : outcome === 'error' ? (signal ? `signal ${signal}` : `exit code ${code}`) : undefined,
      });
    }
    commitReplyPending();
    flushSessionOutput(session, true);
    // FLUX-915/921: terminalize a user-requested stop as 'cancelled' instead of blindly reverting to
    // 'waiting-input'. The stop route synchronously set status='cancelled'+endedAt and killed the
    // proc; this async exit handler used to overwrite that back to 'waiting-input', so Stop never
    // stuck and the session showed active forever (getActiveSessionsForTask counts waiting-input;
    // reconcileDeadSessions skips it). A clean OR crashed resumed turn stays resumable — a persistent
    // conversation recovers via --resume, and the board tee below still surfaces a crash.
    terminalizeResumedExit(session);
    // FLUX-651: resumed chat turn ended — flag if the agent parked without acting. Skip a turn the
    // agent paused for Require Input (that IS an action) or one the user stopped (FLUX-915).
    if (!session.pausedForInput && !session.requestedStop) await flagIfParked(session, id);
    // FLUX-849: bracket the dispatched session's board narration on this resumed path.
    // - Require-Input pause → 'needs input'.
    // - User-requested stop → 'stopped'.
    // - Non-zero/signalled crash → 'failed' (previously silent — the only resumed-path tee was the
    //   pause, so a crashed resumed turn left no board signal at all).
    // A clean turn-end (code 0) already narrated via the 'working' tee and stays resumable, so it
    // gets no terminal marker here (a finish that moves the ticket surfaces via the status path).
    if (session.pausedForInput) {
      teeDispatchActivityToBoard(session, id, 'waiting-input', DISPATCH_LIFECYCLE_LABEL['waiting-input']);
    } else if (session.requestedStop) {
      teeDispatchActivityToBoard(session, id, 'cancelled', DISPATCH_LIFECYCLE_LABEL['cancelled']);
    } else if (code !== 0 || signal) {
      // FLUX-981: a crashed resumed turn (nonzero/signal, not user-stopped) was silent in the chat —
      // it only reverted to waiting-input + a board marker. Surface it inline too.
      const replyOutcome = `${session.label} reply ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;
      const stderrHint = session.stderrCapture?.trim();
      appendErrorToSession(session, stderrHint ? `${replyOutcome}\n${stderrHint}` : replyOutcome);
      teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);
      // S10 (epic FLUX-996): same needsAction + notification surfacing as the initial-spawn path.
      // Only raise when this handler is the first to observe the outcome (FLUX-1204) — a spurious
      // 'error' that already fired must not be double-counted by this non-zero/signalled 'exit'.
      if (isFirstOutcome) void raiseNeedsAction(id, replyOutcome);
    }
    broadcastEvent('taskUpdated', { id });
  });
}

