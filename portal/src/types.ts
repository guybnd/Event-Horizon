export interface AgentSessionProgress {
  timestamp: string;
  message: string;
  type?: 'text' | 'topic' | 'tool' | 'info';
  data?: { summary?: string; parameters?: unknown };
}

export interface AgentSessionEntry {
  type: 'agent_session';
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  outcome?: string;
  /** Absent on terminal entries in the list payload; compacted after session end. */
  progress?: AgentSessionProgress[];
  /** Agent's final text output — set when the engine compacts a finished session. */
  finalMessage?: string;
  /** Progress length before compaction. */
  originalProgressCount?: number;
  /** Progress length hint when the array itself was stripped (list payload). */
  progressCount?: number;
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
  type: 'status_change' | 'comment' | 'activity' | 'agent_message' | 'swimlane_change';
  from?: string;
  to?: string;
  swimlane?: string;
  action?: 'set' | 'cleared';
  user: string;
  date: string;
  comment?: string;
  id?: string;
  replyTo?: string;
  /** Optional agent-written digest summary (FLUX-501) — shown collapsed in the agent digest. */
  summary?: string;
  /** Pinned entries are never collapsed in the agent digest. */
  pin?: boolean;
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

export type RelationType =
  | 'relates'
  | 'blocks'
  | 'blocked-by'
  | 'retries'
  | 'refactors'
  | 'refactored-by'
  | 'duplicates'
  | 'duplicated-by';

/** A typed relationship from one ticket to another (FLUX-593 / epic FLUX-596). */
export interface TicketLink {
  type: RelationType;
  target: string; // target ticket id (e.g. 'PR-14' or 'FLUX-581')
  label?: string;
}

export interface Task {
  id: string;
  status: string;
  /** 'pr' = an engine-managed PR ticket (FLUX-566); undefined/'ticket' = a normal ticket. */
  kind?: 'ticket' | 'pr';
  swimlane?: string | null;
  /** FLUX-651: set by the engine when an agent ended its turn leaving the ticket parked in a
   *  working status without taking a board action. Truthy = show as "Needs Action"; the string
   *  is the reason. Cleared automatically when the ticket's status moves or work resumes. */
  needsAction?: string | null;
  /** PR tickets only: the gh PR number, draft flag, and the work-gated member ticket ids. */
  prNumber?: number;
  prState?: string;
  reviewDecision?: string | null;
  /** FLUX-816: the outcome of an EH (non-GitHub) review — set by the review orchestrator when it
   *  concludes (approve→Ready, changes-requested→In Progress) or set/cleared manually by a human.
   *  Surfaces a review badge on the card. Distinct from `reviewDecision` (GitHub-synced, PR-only,
   *  uppercase enum); on PR cards the badge falls back to this when `reviewDecision` is absent.
   *  null = never reviewed (no badge — never a false "approved"). No stale-review auto-invalidation. */
  reviewState?: 'approved' | 'changes-requested' | null;
  isDraft?: boolean;
  members?: string[];
  /** Typed relationships to other tickets (FLUX-593 'retries'; generalized by epic FLUX-596). */
  links?: TicketLink[];
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
  /** True when this session can be continued via `claude --resume` (FLUX-606). */
  resumable?: boolean;
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

export type BoardCardOpenMode = 'popup' | 'full' | 'chat';

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

export interface SwimlaneDef {
  id: string;
  label: string;
  color: string;
  commentRequired?: boolean;
}

export interface ModuleInstallDocs {
  requires: string;
  command: string;
  url?: string;
}

export interface ModuleDeclaration {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  mcpServer?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  installDocs?: ModuleInstallDocs;
  promptFragment?: string;
  phases?: string[];
  conditions?: {
    requireTags?: string[];
  };
}

export type ProbeStatus = 'ok' | 'error' | 'checking' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  message: string;
  checkedAt: string;
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
  /** Default state of the per-launch "dedicated worktree" choice (FLUX-521). */
  worktreeByDefault?: boolean;
  requireInputStatus?: string;
  readyForMergeStatus?: string;
  archiveStatus?: string;
  swimlanes?: SwimlaneDef[];
  docsEditPermissions?: DocsEditPermissions;
  docsAllowedUsers?: string[];
  docsRoot?: string;
  animationsEnabled?: boolean;
  animationSpeed?: 'fast' | 'normal' | 'slow';
  hoverPopupsEnabled?: boolean;
  hoverPopupDelay?: number;
  /** Open the comment popover when hovering a card's comment badge. Off by default —
   *  the badge still opens its popover on click. */
  commentHoverPreviewEnabled?: boolean;
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
  /** Per-surface default permission mode — the workspace "risk tolerance" (FLUX-605).
   *  The per-chat Perms picker inherits these when left on "Default"; an explicit
   *  per-chat choice overrides. 'gated' routes destructive ops through human approval
   *  (--permission-prompt-tool); 'skip' uses --dangerously-skip-permissions. */
  permissions?: {
    boardDefault?: 'gated' | 'skip';
    ticketDefault?: 'gated' | 'skip';
  };
  modules?: ModuleDeclaration[];
  boardFx?: {
    /** Column count badge ignites as cards pile up */
    columnFire?: boolean;
    /** Old stale tickets develop a rust/sepia tint over time */
    ticketAgeRust?: boolean;
    /** Drag overlay card emits a trailing light glow */
    dragTrail?: boolean;
    /** Empty columns show a subtle drifting dust effect */
    idleDust?: boolean;
    /** Board health weather icon in the header */
    boardWeather?: boolean;
    /** Animated flow arrows between columns showing ticket movement */
    columnFlowArrows?: boolean;
    /** Token-rate heartbeat strip at top of viewport during agent runs */
    heartbeat?: boolean;
    /** ⚡ badge on tickets completed in under 2 hours */
    speedDemon?: boolean;
    /** Done-today streak counter in the Done column header */
    doneStreak?: boolean;
    /** Tiny generative waveform fingerprint on each card */
    ticketDna?: boolean;
  };
}

