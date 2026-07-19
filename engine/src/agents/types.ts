import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { ChatAttachment } from '../projection.js';
import type { AgentSessionEntry } from '../history.js';

/** FLUX-674: optional per-turn extras for a chat reply (pasted image attachments). */
export interface SendInputOptions {
  attachments?: ChatAttachment[];
  /**
   * FLUX-1175: a server-resolved persona prompt (via `resolvePersonaPrompt`) to use as this
   * board turn's identity block instead of the default board-orchestrator identity. Read only on
   * the opening turn (`startBoardSession`) — a persona's identity is established once, same as a
   * per-ticket chat launch; later turns in the same conversation are plain user input.
   */
  personaPrompt?: string;
  /**
   * FLUX-1390: this `sendInput` call is the engine's own wake ticker resuming a `scheduled` session
   * (not a human chat reply) — the exit handler finalizes a clean, no-further-sleep turn as
   * `completed`/`failed` (mirroring a fresh dispatch) instead of the interactive
   * `terminalizeResumedExit` fallback (always `waiting-input`), which would otherwise misreport an
   * unattended phase session as needing a human and get it parked by `decideTicketAction`.
   */
  wakeResume?: boolean;
  /**
   * FLUX-1437: this `sendInput` call is the claude adapter's own stale-wait catch-and-resume (a
   * dispatched turn ended narrating a dead background-task wait promise) — same finalization
   * rationale as `wakeResume` above: the exit handler must finalize a clean, no-further-sleep turn
   * as `completed`/`failed` (mirroring a fresh dispatch), not `terminalizeResumedExit`'s always-
   * `waiting-input` fallback, or this corrective resume would itself misreport as needing a human.
   */
  staleWaitResume?: boolean;
}

export type CliSessionStatus = 'pending' | 'running' | 'waiting-input' | 'scheduled' | 'completed' | 'failed' | 'cancelled';
export type CliFramework = 'claude' | 'copilot' | 'gemini';
export type ExecutionPattern = 'relay' | 'scatter-gather' | 'supervisor';
export type PatternPosition = 'lead' | 'assistant' | 'combiner' | 'step' | 'standalone';
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'finalize' | 'chat' | 'fast-path' | 'batch-grooming';

// FLUX-1373: the three model tiers a board's per-CLI `integrations.<cli>.tiers` config resolves —
// replaces the old binary ModelTier ('cheap'|'strong'). A CLI-agnostic "how much do I want to spend
// on this task" dial; each CLI maps it to a concrete model id (config.ts's tiers defaults).
export type Tier = 'smart' | 'efficient' | 'cheap';

// FLUX-1373: the stable, persisted task taxonomy every dispatched session is stamped with
// (`session.taskKey`) — the key `modelPolicy.assignments` maps to a Tier. Exactly 9 keys, pinned
// by the ticket plan: per-dimension review keys (correctness/style/security) collapse into ONE
// `review.workers`; the old `review.synthesizer` concept is `review.lead`. A key must be
// mechanically derivable at every dispatch site from what the session record carries (phase ×
// position) — see deriveTaskKey in routes/cli-session.ts.
export type TaskKey =
  | 'grooming.lead' | 'grooming.workers'
  | 'planReview'
  | 'implementation.lead' | 'implementation.workers'
  | 'review.lead' | 'review.workers'
  | 'finalize'
  | 'chat';

// FLUX-1373: the full 9-key set, for route-body validation (an explicit `taskKey` override must be
// one of these) and for iterating every key (e.g. building the default `modelPolicy.assignments`).
export const TASK_KEYS: readonly TaskKey[] = [
  'grooming.lead', 'grooming.workers',
  'planReview',
  'implementation.lead', 'implementation.workers',
  'review.lead', 'review.workers',
  'finalize',
  'chat',
];
// Run-group classification: every session launched in one orchestration run shares
// these so any surface can render the topology without inspecting sibling sessions.
export type GroupVariant = 'combiner' | 'headless';

export interface CliCapabilities {
  resume: boolean;
  background: boolean;
  supervisor: boolean;
  scatter: boolean;
  toolGating: boolean;
  structuredOutput: boolean;
  // A.8 (FLUX-900): folded in from the per-adapter PROVIDER_CAPABILITIES tables, which
  // disagreed with each other. `flag` is the CLI literal (e.g. '--effort') and is only
  // meaningful when `supported` is true. Each value preserves the adapter's live behavior.
  effort: { supported: boolean; flag?: string };
  // FLUX-901 (audit B.1–B.7): per-framework OPTIONAL behaviors, verified against current
  // master. Mostly Claude-only; the exceptions are spawnTimeMcpConfig (FLUX-984: Copilot too) and
  // selfPause (FLUX-985: copilot/gemini now honor a Require-Input pause as waiting-input). Shipped to
  // the portal via /api/config so the UI gates features off capability instead of `=== 'claude'`
  // (FLUX-906 consumes these). Distinct from `resume` (any CLI can --resume a session): persistentChat
  // is the narrower "a clean CHAT-turn exit stays 'waiting-input' instead of 'completed'" — copilot/
  // gemini go 'completed' on the first turn (still resumable via resumeSessionId, but not persistent).
  persistentChat: boolean;     // B.1: chat-exit → 'waiting-input' (not 'completed') so the next message resumes the same session
  selfPause: boolean;          // B.2: agent change_status('Require Input') mid-turn keeps the session explicitly resumable
  partialDeltas: boolean;      // B.3: emits token-level assistant deltas (--include-partial-messages → assistantDelta SSE)
  permissionGating: boolean;   // B.4: supports the EH permission-prompt protocol (gated vs skip); others spawn --yolo
  nativeAskBlocked: boolean;   // B.5: the CLI's native AskUserQuestion must be disabled (--disallowed-tools) — a `claude -p` limitation
  spawnTimeMcpConfig: boolean; // B.6: accepts a per-spawn MCP config file (--mcp-config) with phase/tag profile filtering
  imageAttachments: boolean;   // B.7: resolves pasted image attachments into the resumed prompt
  // FLUX-1123: can this CLI actually ENFORCE the FLUX-926 chat file-edit gate (a real
  // --disallowed-tools-equivalent block), as opposed to only receiving an advisory prompt note?
  // Neither Copilot nor Gemini expose a per-tool disallow flag (confirmed against the live CLIs —
  // see the copilot-board.ts / gemini-board.ts FLUX-959 comments), so for them this is false: the
  // ticket-chat gate degrades to a best-effort instruction in the prompt (chatEditGateNote in
  // shared.ts) rather than a real block. Distinct from `toolGating` (generic tool restriction
  // capability, unused today) — this one specifically drives which wording buildInitialPrompt uses.
  chatEditGateEnforced: boolean;
}

export const CLI_CAPABILITIES: Record<CliFramework, CliCapabilities> = {
  claude: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true, effort: { supported: true, flag: '--effort' }, persistentChat: true, selfPause: true, partialDeltas: true, permissionGating: true, nativeAskBlocked: true, spawnTimeMcpConfig: true, imageAttachments: true, chatEditGateEnforced: true },
  gemini: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true, effort: { supported: false }, persistentChat: false, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: false, imageAttachments: false, chatEditGateEnforced: false },
  // FLUX-984: Copilot never auto-loads workspace .mcp.json in non-interactive (-p) mode — confirmed
  // live, no permission flag changes it. spawnTimeMcpConfig:true here means "copilot.ts explicitly
  // injects the event-horizon server via --additional-mcp-config", a different flag/JSON-shape than
  // Claude's --mcp-config but the same capability concept (B.6).
  copilot: { resume: true, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false, effort: { supported: true, flag: '--effort' }, persistentChat: false, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: true, imageAttachments: false, chatEditGateEnforced: false },
};

// FLUX-905 (audit C.17): model-family name fragments per framework, for detecting whether a
// ticket-history author string represents an agent (a session may post under a model display name
// like "Claude (Opus 4.8)", not the canonical 'Agent'). Centralized + type-checked so a new model
// family is a one-line edit here, not a buried regex in history.ts. Drives AGENT_AUTHOR_PATTERN.
export const MODEL_FAMILIES: Record<CliFramework, string[]> = {
  claude: ['claude', 'opus', 'sonnet', 'haiku'],
  copilot: ['copilot', 'gpt', 'codex'],
  gemini: ['gemini'],
};

// FLUX-931: framework -> its config key under `integrations.*` (config.ts: claudeCode/geminiCli/
// copilotCli). Lets callers outside agents/ (e.g. the delegate route) read a framework's own
// integration config generically instead of a hardcoded per-framework literal at each call site.
export const INTEGRATION_CONFIG_KEYS: Record<CliFramework, string> = {
  claude: 'claudeCode',
  gemini: 'geminiCli',
  copilot: 'copilotCli',
};

export interface AgentProcess {
  proc: ChildProcessWithoutNullStreams;
  sessionId: string;
  taskId: string;
}

export interface AgentAdapter {
  readonly manifest: ProviderManifest;
  labelForFramework(): string;
  start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void>;
  sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void>;
  stop(session: CliSessionRecord): void;
}

export interface CliSessionSummary {
  id: string;
  taskId: string;
  framework: CliFramework;
  status: CliSessionStatus;
  command: string;
  args: string[];
  startedAt: string;
  endedAt?: string;
  pid?: number | undefined;
  label: string;
  lastOutputAt?: string;
  lastInputAt?: string;
  blockedReason?: string;
  /**
   * FLUX-1047 / FLUX-1063 / FLUX-1397: structured classification of WHY a terminal session ended, when
   * the raw exit is otherwise an opaque nonzero-exit `failed`:
   *   - `'context-exhausted'` — the single session ran out of context ("prompt is too long" /
   *     context_length_exceeded). Recoverable — re-driven with a FRESH session (no `--resume`).
   *   - `'rate-limited'` — a usage/quota/rate limit (5-hour session limit, HTTP 429, `rate_limit_event`).
   *     Transient: it clears at the provider's reset window, so the stoker cools the ticket down and
   *     auto-retries on a cadence instead of parking it. A fresh session at retry time (no `--resume`).
   *   - `'auth-expired'` — a revoked/expired API key or OAuth token (401/403, "OAuth token has expired").
   *     Transient in the sense that a human re-auth (`claude login` / refreshed key) fixes it, but NOT
   *     something the Furnace can recover from on its own — every ticket sharing the CLI's credential
   *     would fail identically, so the stoker halts the whole batch and asks for re-auth instead of
   *     parking each ticket independently (see furnace-stoker.decideTicketAction).
   * An extensible enum — the durable seam FLUX-996's hardened runner can build on.
   */
  terminalReason?: 'context-exhausted' | 'rate-limited' | 'auth-expired';
  liveOutput?: string;
  currentActivity?: string | undefined;
  skipPermissions?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  costIsEstimated?: boolean;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  role?: string;
  phase?: LaunchPhase;
  /** FLUX-1383: for phase:'batch-grooming', the eligible member ticket ids this session grooms in
   *  one sitting (the anchor `taskId` is always included). Absent/empty for every other phase. */
  batchTicketIds?: string[];
  /** FLUX-1373: the task-tier policy key this session resolves its model through — stamped once at
   *  creation (see deriveTaskKey, routes/cli-session.ts). */
  taskKey?: TaskKey;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  /** Shared by all sessions launched in one orchestration run. */
  groupId?: string;
  /** Order within a relay pipeline (0,1,2...). */
  groupSeq?: number;
  /** Total expected sessions in the group (for relay: total steps). Lets the UI
   *  render placeholder slots before all sessions have spawned. */
  groupTotal?: number;
  /** Authoritative orchestration type of the whole group. */
  groupType?: ExecutionPattern;
  /** Disambiguates the two scatter-gather visuals: fan-in vs swarm of peers. */
  groupVariant?: GroupVariant;
  lockedPaths?: string[];
  outputData?: string;
  /** True when this session can be continued via `claude --resume` — terminal-or-active
   *  with a known `resumeSessionId`. Lets the chat continue a dispatched (now-completed)
   *  phase session's thread instead of spawning a fresh, amnesiac chat (FLUX-606). The raw
   *  `resumeSessionId` is intentionally not exposed to the client; a boolean is enough. */
  resumable?: boolean;
  /** FLUX-1390: ISO time this `scheduled` (sleeping) session will be auto-resumed via `--resume`. */
  wakeAt?: string;
  /** FLUX-1390: the agent's own `reason` for the pending wakeup, if it gave one — surfaced next to `wakeAt`. */
  wakeReason?: string;
  /** FLUX-1434: the `event-horizon` MCP tool names (bare) actually disallowed for this session at
   *  its last spawn/resume — the deny-list model's own computed output, so a gap (a session
   *  missing a tool its mission needs) is a one-glance diagnosis instead of a re-derivation.
   *  Portal-visible, read-only. Empty/absent means unscoped (lead/flex/no-persona/chat). */
  disallowedEhTools?: string[] | undefined;
  /** FLUX-1531: the workspace root this session was spawned under (multi-board, epic FLUX-1230
   *  S13) — stamped once at creation from `getWorkspaceRoot()`, mirroring `FurnaceBatch.workspaceRoot`
   *  (FLUX-1513). Absent on legacy/rehydrated sessions, which fall back to the default workspace —
   *  see `sessionBelongsToWorkspaceRoot` (session-store.ts). */
  workspaceRoot?: string;
}

export interface CliSessionRecord extends CliSessionSummary {
  proc?: ChildProcessWithoutNullStreams;
  resumeSessionId?: string;
  blockedReason?: string;
  outputBuffer: string;
  liveOutputBuffer: string;
  pendingAssistantText: string;
  /** Cumulative assistant text — never flushed, used for relay handoff. */
  cumulativeOutput: string;
  flushTimer?: NodeJS.Timeout | undefined;
  requestedStop: boolean;
  writeQueue: Promise<void>;
  skipPermissions: boolean;
  sessionHistoryEntry?: AgentSessionEntry;
  progressHeartbeat?: NodeJS.Timeout | undefined;
  lastProgressLog?: string | undefined;
  role?: string;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  lockedPaths?: string[];
  outputData?: string;
  /** Pre-computed diff block injected into the initial prompt (scatter-gather reviews). */
  diffBlock?: string;
  /** FLUX-1383: for phase:'batch-grooming', the members the route excluded from `batchTicketIds`
   *  (ineligible effort/epic-parent/status) + why — folded into the initial mission text's
   *  "excluded and named" note. Internal (not part of CliSessionSummary — never exposed to the
   *  client); a one-time launch computation, not re-derived on resume. */
  batchExcluded?: { id: string; reason: string }[];
  /** FLUX-1385: the launched persona id, if any — feeds disallowedEhToolsForPersona so a
   *  worker-role delegate's `event-horizon` MCP toolset is scoped down at spawn. Internal
   *  (not part of CliSessionSummary — never exposed to the client). */
  personaId?: string;
  /** FLUX-1385: this launch's focus text — checked for the sole-reviewer-of-record signal that
   *  restores a scoped-down worker's full write toolset. Internal, same as personaId above. */
  focusComment?: string;
  /** FLUX-1434: explicit per-launch `event-horizon` MCP tool grant (dispatch.enableTools in the
   *  deny-list model — see disallowedEhToolsForPersona in orchestration-personas.ts). Re-stamped
   *  on resume so a resumed session's toolset always matches its current mission. Internal, same
   *  as personaId/focusComment above. */
  enableTools?: string[] | undefined;
  /** FLUX-850: true when this session was launched by an unattended, no-human-present dispatch
   *  path — the MCP `start_session` tool, a board-rebase `dispatch` verb, or Furnace's
   *  `dispatchSession` — as opposed to a human clicking Start/Send in the portal. Portal launches
   *  (chat send, the phase-launch buttons) route through the identical `/cli-session/start`
   *  request and can carry the same `phase`/`skipPermissions` values, so neither is a reliable
   *  "was a human present" signal on its own — this field is the explicit one each dispatch path
   *  stamps itself. Consumed by `change_status`/`finish_ticket` (mcp-server.ts) to hard-gate a
   *  dispatched+skip-permission session from silently advancing a ticket past Ready. Internal
   *  (not part of CliSessionSummary — never exposed to the client), same as personaId/focusComment. */
  dispatched?: boolean;
  /** Set when the session paused itself via change_status('Require Input'). */
  pausedForInput?: boolean;
  /**
   * FLUX-1479 (FLUX-1226 Phase E): the destination phase of a phase->persona HANDOFF applied to a
   * persistent per-ticket chat session (`phase === 'chat'`, FLUX-602) on a ticket status
   * transition — e.g. a Scratch chat promoted then moved Grooming -> Todo. Deliberately a
   * SEPARATE field from `phase` (never overwritten): `phase` staying `'chat'` is what
   * `reapStaleParkedSessions`/session-store rely on to keep this the SAME persistent conversation
   * across status moves (session-store.ts's FLUX-602 comment) — mutating it directly would make
   * the session look like a stale dispatched session and eligible for reaping. Consumers that want
   * the session's CURRENT logical phase (persona/prompt resolution in buildInitialPrompt's callers,
   * deny-list recompute in disallowedToolsArgs/stampDisallowedEhTools) read `handoffPhase ?? phase`;
   * consumers about the session's LIFECYCLE model (ScheduleWakeup eligibility, reaping) keep
   * reading raw `phase` unchanged. Cleared back to `undefined` when a transition derives no phase
   * for the new status (falls back to the plain chat persona). Internal — not part of
   * CliSessionSummary, never exposed to the client. */
  handoffPhase?: LaunchPhase | undefined;
  /** FLUX-1479: whether `handoffPhase`'s one-time announcement note (`buildPhaseHandoffNote`) has
   *  already been delivered into the conversation. Reset to `false` whenever `handoffPhase` changes
   *  to a new value; consumed (set `true`) by the adapter that actually sends the note. */
  handoffPhaseAnnounced?: boolean | undefined;
  /**
   * The agent EXECUTION root this session spawned in (its worktree, or the engine
   * root) — FLUX-519. Captured at start so a later reply (sendInput) resumes in the
   * SAME tree, and so we can refuse to resume on master if the worktree was removed.
   */
  executionRoot?: string;
  /** Per-conversation model + effort override from the chat picker (FLUX-604). */
  model?: string;
  effortOverride?: string;
  /** FLUX-605: 'gated' = route tool decisions through EH approval (--permission-prompt-tool);
   *  'skip' = --dangerously-skip-permissions. Undefined falls back to skipPermissions. */
  permissionMode?: 'gated' | 'skip';
  /** FLUX-651: ticket status + subtask count captured at the START of the current turn,
   *  so the turn-end backstop can tell whether the agent actually took a board action
   *  (status moved / Require Input raised / subtask created) or just parked. */
  statusAtTurnStart?: string | undefined;
  subtaskCountAtTurnStart?: number;
  /** FLUX-826: agent-comment count at turn start + whether the agent raised a structured
   *  `ask_user_question` this turn — feed the SOFT resting-status backstop (a fresh comment
   *  with no board action and no structured prompt surfaces a needs-action nudge). */
  commentCountAtTurnStart?: number;
  askedThisTurn?: boolean;
  /** FLUX-981: last surfaced rate-limit key (`${status}:${rateLimitType}`) — de-dups the inline
   *  ⚠️ rate-limit line so a stream that re-emits `rate_limit_event` on every retry/backoff while
   *  throttled produces ONE chat line, not one per event. Cleared when status returns to 'allowed'. */
  lastRateLimitKey?: string | undefined;
  /** FLUX-981: tool_use id → tool name, captured from Claude `assistant` tool_use blocks so a later
   *  `user` `tool_result` carrying `is_error` can be labeled with the tool that failed (the result
   *  block itself carries only the id). Bounded — cleared at result/turn end. */
  toolNamesById?: Record<string, string> | undefined;
  /** Last ≤500 chars of stderr output — appended to the ⚠️ failure message so errors like
   *  "GitHub Copilot extension is not installed" that arrive on stderr rather than stdout
   *  are surfaced in the chat log instead of silently dropped. */
  stderrCapture?: string;
  /** FLUX-1378: the session's live context size as of the LAST `result` event (non-cumulative —
   *  overwritten every turn, unlike inputTokens/etc. which accumulate). Used by
   *  `resumeOrDispatchSession`'s viability check: a session sitting near its context window is
   *  worse to resume (large cache-read bill, close to auto-compaction) than to cold-spawn fresh. */
  lastTurnContextTokens?: number;
  /** FLUX-1378: the resolved model's context window (from the CLI result event's `modelUsage`),
   *  captured alongside `lastTurnContextTokens`. Undefined when the adapter/CLI doesn't report it —
   *  callers fall back to a conservative default rather than treating undefined as "unlimited". */
  contextWindow?: number;
  /** FLUX-1378 (absorbing FLUX-1375 step 6): running total of inputTokens/etc. already flushed into
   *  the ticket's `tokenMetadata`, since `session.inputTokens` etc. accumulate for the WHOLE session
   *  (never reset — they also drive the live per-session cost badge) across every resumed turn. Each
   *  flush point computes the delta against these baselines — not the raw cumulative counters — so a
   *  second (resume-turn) flush doesn't double-count tokens the first (initial-spawn) flush already
   *  persisted. Internal bookkeeping only; never exposed on CliSessionSummary. */
  flushedInputTokens?: number;
  flushedOutputTokens?: number;
  flushedCostUSD?: number;
  flushedCacheReadTokens?: number;
  flushedCacheCreationTokens?: number;
  /** FLUX-1378: count of successful `resumeOrDispatchSession` resumes since this session was COLD
   *  spawned (a fresh spawn always starts a new session object, so this is inherently scoped to "since
   *  last cold spawn" with no explicit reset needed). Fallback viability signal for a session with no
   *  recorded `lastTurnContextTokens` (pre-upgrade stub / a non-reporting adapter) — capped at 8. */
  resumeTurnCount?: number;
  /**
   * FLUX-1390: honored-ScheduleWakeup bookkeeping (agents.honorScheduledWakeups, claude-only — the
   * tool is a Claude Code native, not something gemini/copilot expose).
   *   - `pendingWakeAt`/`pendingWakeReason` — staged mid-turn when the assistant calls ScheduleWakeup;
   *     consumed at turn-end by `tryEnterScheduledWake`, which commits them to `wakeAt`/`wakeReason`
   *     (and clears the pending pair) if the turn is honoring a sleep, or drops them otherwise.
   *   - `wakeAt`/`wakeReason` — the ACTIVE sleep: when a `status: 'scheduled'` session should next be
   *     resumed via `--resume`, and why (inherited from `CliSessionSummary` above). Cleared once the
   *     wake ticker (scheduled-wake.ts) picks it up.
   *   - `scheduledResumeCount` — how many times this session has already self-scheduled a resume;
   *     `tryEnterScheduledWake` fails closed once it reaches MAX_SCHEDULED_WAKE_RESUMES.
   */
  pendingWakeAt?: string;
  pendingWakeReason?: string;
  scheduledResumeCount?: number;
  /**
   * FLUX-1437: how many times the claude adapter's stale-wait catch-and-resume has already
   * resumed THIS session — a dispatched (non-chat) turn that ended narrating an unarmed "I'll wait
   * for X" promise (`WAIT_PROMISE_RE`) with no board action taken. Capped at 1 (mirrors
   * `scheduledResumeCount`'s bound precedent): a session that stalls on the same failure mode twice
   * falls through to the normal `flagIfParked` park instead of resuming again.
   */
  staleWaitResumes?: number;
}

export interface AgentEvent {
  type: 'assistant_text' | 'tool_use' | 'permission_request' | 'token_usage' | 'done' | 'error';
  payload: unknown;
}

export interface FieldSchema {
  type: 'string' | 'boolean' | 'select';
  label: string;
  options?: string[];
}

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
