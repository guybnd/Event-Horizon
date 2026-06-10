import type { ChildProcessWithoutNullStreams } from 'child_process';

export type CliSessionStatus = 'pending' | 'running' | 'waiting-input' | 'completed' | 'failed' | 'cancelled';
export type CliFramework = 'claude' | 'copilot' | 'gemini';
export type ExecutionPattern = 'relay' | 'scatter-gather' | 'supervisor';
export type PatternPosition = 'lead' | 'assistant' | 'combiner' | 'step' | 'standalone';
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'finalize';
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
}

export const CLI_CAPABILITIES: Record<CliFramework, CliCapabilities> = {
  claude: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true },
  gemini: { resume: false, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false },
  copilot: { resume: true, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false },
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
  sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string): Promise<void>;
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
  pid?: number;
  label: string;
  lastOutputAt?: string;
  lastInputAt?: string;
  blockedReason?: string;
  liveOutput?: string;
  currentActivity?: string;
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
}

export interface CliSessionRecord extends CliSessionSummary {
  proc?: ChildProcessWithoutNullStreams;
  claudeSessionId?: string;
  blockedReason?: string;
  outputBuffer: string;
  liveOutputBuffer: string;
  pendingAssistantText: string;
  /** Cumulative assistant text — never flushed, used for relay handoff. */
  cumulativeOutput: string;
  flushTimer?: NodeJS.Timeout;
  requestedStop: boolean;
  writeQueue: Promise<void>;
  skipPermissions: boolean;
  sessionHistoryEntry?: any;
  progressHeartbeat?: NodeJS.Timeout;
  lastProgressLog?: string;
  role?: string;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  lockedPaths?: string[];
  outputData?: string;
  /** Pre-computed diff block injected into the initial prompt (scatter-gather reviews). */
  diffBlock?: string;
  /** Set when the session paused itself via change_status('Require Input'). */
  pausedForInput?: boolean;
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
