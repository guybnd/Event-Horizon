import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { ChatAttachment } from '../projection.js';

/** FLUX-674: optional per-turn extras for a chat reply (pasted image attachments). */
export interface SendInputOptions {
  attachments?: ChatAttachment[];
}

export type CliSessionStatus = 'pending' | 'running' | 'waiting-input' | 'completed' | 'failed' | 'cancelled';
export type CliFramework = 'claude' | 'copilot' | 'gemini';
export type ExecutionPattern = 'relay' | 'scatter-gather' | 'supervisor';
export type PatternPosition = 'lead' | 'assistant' | 'combiner' | 'step' | 'standalone';
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'finalize' | 'chat';
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
}

export const CLI_CAPABILITIES: Record<CliFramework, CliCapabilities> = {
  claude: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true, effort: { supported: true, flag: '--effort' }, persistentChat: true, selfPause: true, partialDeltas: true, permissionGating: true, nativeAskBlocked: true, spawnTimeMcpConfig: true, imageAttachments: true },
  gemini: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true, effort: { supported: false }, persistentChat: false, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: false, imageAttachments: false },
  // FLUX-984: Copilot never auto-loads workspace .mcp.json in non-interactive (-p) mode — confirmed
  // live, no permission flag changes it. spawnTimeMcpConfig:true here means "copilot.ts explicitly
  // injects the event-horizon server via --additional-mcp-config", a different flag/JSON-shape than
  // Claude's --mcp-config but the same capability concept (B.6).
  copilot: { resume: true, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false, effort: { supported: true, flag: '--effort' }, persistentChat: false, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: true, imageAttachments: false },
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
   * FLUX-1047 / FLUX-1063: structured classification of WHY a terminal session ended, when the raw exit
   * is otherwise an opaque nonzero-exit `failed`. Both variants are *recoverable* conditions the Furnace
   * stoker reads to retry rather than immediately park:
   *   - `'context-exhausted'` — the single session ran out of context ("prompt is too long" /
   *     context_length_exceeded). Recovered by re-driving with a FRESH session (no `--resume`).
   *   - `'rate-limited'` — a usage/quota/rate limit (5-hour session limit, HTTP 429, `rate_limit_event`).
   *     Transient: it clears at the provider's reset window, so the stoker cools the ticket down and
   *     auto-retries on a cadence instead of parking it. A fresh session at retry time (no `--resume`).
   * An extensible enum — the durable seam FLUX-996's hardened runner can build on.
   */
  terminalReason?: 'context-exhausted' | 'rate-limited';
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
  sessionHistoryEntry?: any;
  progressHeartbeat?: NodeJS.Timeout | undefined;
  lastProgressLog?: string | undefined;
  role?: string;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  lockedPaths?: string[];
  outputData?: string;
  /** Pre-computed diff block injected into the initial prompt (scatter-gather reviews). */
  diffBlock?: string;
  /** Set when the session paused itself via change_status('Require Input'). */
  pausedForInput?: boolean;
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
  statusAtTurnStart?: string;
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
