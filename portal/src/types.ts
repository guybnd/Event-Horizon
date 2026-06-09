export interface AgentSessionProgress {
  timestamp: string;
  message: string;
  type?: 'text' | 'topic' | 'tool' | 'info';
  data?: any;
}

export interface AgentSessionEntry {
  type: 'agent_session';
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  outcome?: string;
  progress: AgentSessionProgress[];
  user: string;
  date: string;
  id?: string;
  replyTo?: string;
  comment?: string;
  role?: string;
  groupId?: string;
  pattern?: ExecutionPattern;
}

export interface BasicHistoryEntry {
  type: 'status_change' | 'comment' | 'activity' | 'agent_message';
  from?: string;
  to?: string;
  user: string;
  date: string;
  comment?: string;
  id?: string;
  replyTo?: string;
}

export type HistoryEntry = BasicHistoryEntry | AgentSessionEntry;

// Type guard to check if a history entry is an agent session
export function isAgentSession(entry: HistoryEntry): entry is AgentSessionEntry {
  return entry.type === 'agent_session';
}

export interface InlineSubtask {
  id: string;
  title?: string;
  status?: string;
}

export function normalizeSubtaskId(entry: string | InlineSubtask): string {
  return typeof entry === 'string' ? entry : entry.id;
}

export interface Task {
  id: string;
  status: string;
  assignee?: string;
  tags?: string[];
  title?: string;
  body?: string;
  history?: HistoryEntry[];
  createdBy?: string;
  updatedBy?: string;
  order?: number;
  priority?: string;
  effort?: string;
  effortLevel?: string;
  implementationLink?: string;
  branch?: string;
  baselineCommit?: string;
  diffSummary?: { file: string; additions: number; deletions: number }[];
  parentId?: string;
  subtasks?: (string | InlineSubtask)[];
  version?: string;
  releasedAt?: string;
  releaseDocPath?: string;
  cliSession?: CliSessionSummary | null;
  cliSessions?: CliSessionSummary[];
  tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated?: boolean; cacheReadTokens?: number; cacheCreationTokens?: number };
  sessionHistoryEntry?: AgentSessionEntry;
}

export type CliFramework = 'claude' | 'copilot' | 'gemini';
export type CliSessionStatus = 'pending' | 'running' | 'waiting-input' | 'completed' | 'failed' | 'cancelled';

export type ExecutionPattern = 'relay' | 'scatter-gather' | 'supervisor';
export type PatternPosition = 'lead' | 'assistant' | 'combiner' | 'step' | 'standalone';
export type GroupVariant = 'combiner' | 'headless';

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
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  groupId?: string;
  groupSeq?: number;
  groupTotal?: number;
  groupType?: ExecutionPattern;
  groupVariant?: GroupVariant;
}

export interface TaskLiveEvent {
  kind: 'created' | 'moved' | 'updated';
  sequence: number;
  at: number;
  fromStatus?: string;
  toStatus?: string;
}

export interface ColumnLiveEvent {
  kind: 'created' | 'received';
  sequence: number;
  at: number;
  taskId: string;
}

export interface TagDef {
  name: string;
  color: string;
  originalName?: string;
}

export interface StatusDef {
  name: string;
  color?: string;
  originalName?: string;
}

export interface UserDef {
  name: string;
  avatar?: string;
  originalName?: string;
}

export interface PriorityDef {
  name: string;
  color: string;
  icon?: string;
  originalName?: string;
}

export type BoardCardOpenMode = 'popup' | 'full';

export type DocsEditPermissions = 'all' | 'specified';

export interface Doc {
  path: string;
  title: string;
  body: string;
  slug: string;
  directory: string;
  order?: number;
  /** Read-only cross-project group doc (surfaced under the Product prefix). */
  readOnly?: boolean;
  /** True for group docs (vs the repo's own .docs/). */
  group?: boolean;
  /** True when this group doc is editable but its writes route through the group parent (bound member, FLUX-419). */
  viaParent?: boolean;
}

export interface Config {
  columns: StatusDef[];
  hiddenStatuses: StatusDef[];
  users: UserDef[];
  tags: TagDef[];
  priorities: PriorityDef[];
  projects: string[];
  enableBacklogScreen: boolean;
  requireCommentOnStatusChange: boolean;
  boardCardOpenMode?: BoardCardOpenMode;
  requireInputStatus?: string;
  readyForMergeStatus?: string;
  archiveStatus?: string;
  docsEditPermissions?: DocsEditPermissions;
  docsAllowedUsers?: string[];
  docsRoot?: string;
  animationsEnabled?: boolean;
  animationSpeed?: 'fast' | 'normal' | 'slow';
  hoverPopupsEnabled?: boolean;
  hoverPopupDelay?: number;
  releaseSettings?: {
    generateDistinctFiles: boolean;
    releaseNotesPath: string;
  };
  integrations?: {
    claudeCode?: {
      groomingModel?: string;
      implementationModel?: string;
    };
    geminiCli?: {
      groomingModel?: string;
      implementationModel?: string;
    };
  };
  defaultAgent?: CliFramework | 'auto';
  /** Workflow template the launcher pre-selects by default (empty = none). */
  defaultWorkflowId?: string;
  /** Per-phase default templates for one-click single / multi agent launches. */
  phaseDefaults?: Partial<Record<'grooming' | 'implementation' | 'review' | 'finalize', { single?: string; multi?: string }>>;
  enableFireworks?: boolean;
  tokenDisplayMode?: 'cost' | 'tokens';
  tokenCostThresholds?: { green: number; yellow: number };
  effortLevel?: string;
  syncSettings?: {
    debounceMs: number;
    maxWaitMs: number;
  };
  agentProgress?: {
    enabled: boolean;
    inlineDelay: number;
  };
}

