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

/**
 * FLUX-1147: structured completion handoff (changed files, validation commands run, decisions,
 * residual risk, docs updated) attached to the `comment` history entry a `change_status` (Ready
 * move) or `finish_ticket` call writes — a machine-readable companion to the required prose
 * comment, never a replacement for ticket frontmatter. Mirrors `engine/src/completion-payload.ts`.
 */
export interface CompletionPayload {
  changedFiles?: string[];
  validation?: { command: string; passed: boolean }[];
  decisions?: string[];
  residualRisk?: string;
  docsUpdated?: string[] | boolean;
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
  /** FLUX-1147: present only on some `comment` entries — see `CompletionPayload`. */
  completion?: CompletionPayload;
}

export type HistoryEntry = BasicHistoryEntry | AgentSessionEntry;

/**
 * A history entry as sent through `appendHistory` (FLUX-725/FLUX-957): `date` is optional
 * because the engine always stamps it server-side when appending the delta (see
 * `routes/tasks.ts`'s `appendHistoryEntries` handling) — callers commonly omit it.
 */
export type HistoryEntryDraft =
  | (Omit<BasicHistoryEntry, 'date'> & { date?: string })
  | (Omit<AgentSessionEntry, 'date'> & { date?: string });

/**
 * Compact, board-card-facing digest of a ticket's history (FLUX-725). The `/api/tasks` LIST
 * payload ships this on `Task.historyDigest` INSTEAD of the raw `history[]` array; the cards +
 * attention surfaces read every history-derived signal from here, and the modal/chat lazy-fetch
 * the full `history` from the detail endpoint. Mirror of the engine's `buildHistoryDigest`.
 */
export interface HistoryDigest {
  length: number;
  lastEntry: { date: string; type: string } | null;
  /** Max entry date — ticket-age rust + Epics "recently active" sort. */
  lastActivityAt: string;
  /** Most recent status_change INTO the current status (time-in-column), or null. */
  enteredCurrentStatusAt: string | null;
  /** In-progress → done in under 2h (the ⚡ speed-demon badge). */
  isSpeedDemon: boolean;
  /** status_change entries within the last 24h — board-wide flow arrows + done streak. */
  statusChanges24h: Array<{ from: string; to: string; date: string }>;
  /** Comment entries with an id (id + author for the own-vs-other unread filter). No text. */
  comments: Array<{ id: string; user: string; date: string }>;
  /** Pre-computed Require-Input question + set-date — only set for require-input tickets. */
  requireInput: { question: string; setDate: string } | null;
  /** FLUX-1289: the plan-review gate's latest feedback comment — only set while `planReviewState`
   *  is non-null. Surfaced inline in the AttentionDock's plan-approval item + ChatPlanApprovalCard.
   *  FLUX-1303: `user` attributes the feedback (reviewer vs the human's own re-groom notes). */
  planReviewComment: { text: string; date: string; user?: string } | null;
}

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
  | 'duplicated-by'
  | 'continues'
  | 'continued-by';

/** A typed relationship from one ticket to another (FLUX-593 / epic FLUX-596). */
export interface TicketLink {
  type: RelationType;
  target: string; // target ticket id (e.g. 'PR-14' or 'FLUX-581')
  label?: string;
}

export interface Task {
  id: string;
  status: string;
  /** 'pr' = an engine-managed PR ticket (FLUX-566); 'scratch' = a freeform Scratch Chat with its
   *  own SCRATCH-n id, spawned from the ChatDock and hidden from board columns + list_tickets
   *  (FLUX-1225); undefined/'ticket' = a normal ticket. */
  kind?: 'ticket' | 'pr' | 'scratch';
  swimlane?: string | null;
  /** FLUX-651: set by the engine when an agent ended its turn leaving the ticket parked in a
   *  working status without taking a board action. Truthy = show as "Needs Action"; the string
   *  is the reason. Cleared automatically when the ticket's status moves or work resumes. */
  needsAction?: string | null;
  /** FLUX-657: redirect pointer set when this ticket was folded into a survivor by the `merge`
   *  verb. Truthy = tombstoned survivor of a merge; the value is the survivor ticket id whose view
   *  now re-derives this ticket's turns. Validated in schema.ts; the card redirects here. */
  mergedInto?: string | null;
  /** PR tickets only: the gh PR number, draft flag, and the work-gated member ticket ids. */
  prNumber?: number;
  prState?: string;
  reviewDecision?: string | null;
  /** FLUX-1315: PR tickets only — aggregate of GitHub's check-run rollup, refreshed on the
   *  existing PR-reconcile poll (`syncPrTickets`). 'unknown' = no checks configured on the PR
   *  (the card renders no chip for it, to avoid a stuck/alarming state). */
  ciStatus?: 'passing' | 'failing' | 'pending' | 'unknown';
  /** FLUX-816: the outcome of an EH (non-GitHub) review — set by the review orchestrator when it
   *  concludes (approve→Ready, changes-requested→In Progress) or set/cleared manually by a human.
   *  Surfaces a review badge on the card. Distinct from `reviewDecision` (GitHub-synced, PR-only,
   *  uppercase enum); on PR cards the badge falls back to this when `reviewDecision` is absent.
   *  null = never reviewed (no badge — never a false "approved"). FLUX-1089: the engine clears this
   *  when a ticket leaves Ready without a fresh verdict, so a bounced-back ticket never keeps
   *  showing a stale 'approved'. */
  reviewState?: 'approved' | 'changes-requested' | null;
  /** FLUX-1071 (Temper): true while this ticket is in the auto-review loop (engine-driven). Drives the
   *  "tempering…" card badge. `temperAttempts` is the re-implementation count so far. */
  tempering?: boolean;
  temperAttempts?: number;
  /** FLUX-1261: per-ticket override of one or both gates — wins over `config.gatePolicy.boardDefault`
   *  for this ticket only (board-default → ticket-override cascade). Engine-internal in v1: not yet
   *  editable from a portal surface (the presets/merge-lock subtask surfaces override authorship). */
  gatePolicyOverride?: Partial<Record<GateName, GateValue>>;
  /** FLUX-1247 epic decision #2: verdict from the `plan` gate's auto-review pass, parallel to
   *  `reviewState` (kept separate so `review`'s existing field/behavior is untouched). Written by
   *  the "Plan-review runner" (FLUX-1263) when `plan` resolves to `auto`/`auto-then-you`; under
   *  `auto-then-you` the ticket stays in `Grooming` with this set until a human confirms, which is
   *  what the AttentionDock 📋 plan-approval item (FLUX-1262) detects. null/absent = no pending
   *  auto-review verdict. */
  planReviewState?: 'approved' | 'changes-requested' | null;
  /** FLUX-1288: true while the plan gate's own auto-loop is actively re-driving this ticket (a
   *  revise/re-review session in flight). Portal surfaces gate the manual "Revise plan"/"Re-run
   *  review" affordances on this being falsy, so a human action never races the auto-loop's own. */
  planGateRunning?: boolean;
  /** FLUX-1303: djb2/base36 hash of the plan body at the moment the current `planReviewState`
   *  verdict was recorded (see `planBodyHash` — engine + portal copies). Lets surfaces tell
   *  whether the plan changed since that review; gates the panel's "Re-review plan" action. */
  planReviewBodyHash?: string | null;
  isDraft?: boolean;
  members?: string[];
  /** Typed relationships to other tickets (FLUX-593 'retries'; generalized by epic FLUX-596). */
  links?: TicketLink[];
  assignee?: string;
  tags?: string[];
  title?: string;
  body?: string;
  /** Full history — present on the DETAIL payload (serializeTaskForApi); absent on the LIST
   *  payload, which carries `historyDigest` instead (FLUX-725). */
  history?: HistoryEntry[];
  /** Compact derived history digest — present on the LIST payload only (FLUX-725). */
  historyDigest?: HistoryDigest;
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
  /** FLUX-873: rich grooming artifact pointer — revision-keyed self-contained HTML published via the
   *  `publish_artifact` MCP tool. Each publish appends a revision (history is kept); the viewer
   *  defaults to `latest`. The HTML lives in a sidecar served by GET /api/tasks/:id/artifact?rev=,
   *  never inlined in the body. */
  artifacts?: {
    latest: number;
    revisions: { rev: number; title?: string; note?: string; createdAt: string; bytes: number }[];
  };
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

// FLUX-906 (audit E.3): the frontend mirrors this union and the capability shape below because
// the portal and engine are separate TS builds with no shared package. This is a documented
// leave-with-justification — it is a STRUCTURAL mirror, not a feature gate: the runtime source of
// truth is the `cliCapabilities` table served on /api/config (engine/src/agents/types.ts), which
// the UI reads to decide what to show. Keep these keys in lockstep with the engine union.
export type CliFramework = 'claude' | 'copilot' | 'gemini';

// FLUX-1373: the three-tier spend model. Each CLI defines what a tier resolves to
// (`integrations.<cli>.tiers`); `modelPolicy.assignments` maps a task key to a tier.
export type Tier = 'smart' | 'efficient' | 'cheap';

/** Stable persisted task-key contract — exactly 9 keys, stamped on every session at dispatch. */
export type TaskKey =
  | 'grooming.lead'
  | 'grooming.workers'
  | 'planReview'
  | 'implementation.lead'
  | 'implementation.workers'
  | 'review.lead'
  | 'review.workers'
  | 'finalize'
  | 'chat';

export type ModelPreset = 'splurge' | 'balanced' | 'frugal' | 'custom';

/** Mirror of the engine's CliCapabilities (engine/src/agents/types.ts), served on /api/config.
 *  The UI gates features off these flags (FLUX-906) instead of `framework === 'claude'`. */
export interface CliCapabilities {
  resume: boolean;
  background: boolean;
  supervisor: boolean;
  scatter: boolean;
  toolGating: boolean;
  structuredOutput: boolean;
  effort: { supported: boolean; flag?: string };
  persistentChat: boolean;
  selfPause: boolean;
  partialDeltas: boolean;
  permissionGating: boolean;
  nativeAskBlocked: boolean;
  spawnTimeMcpConfig: boolean;
  imageAttachments: boolean;
}
export type CliSessionStatus = 'pending' | 'running' | 'waiting-input' | 'scheduled' | 'completed' | 'failed' | 'cancelled';

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
  /** FLUX-1281: the launch phase this session was dispatched under (mirror of the engine's
   *  `LaunchPhase`). Lets the dock tab's leading glyph prefer the ACTIVE session's identity over
   *  the ticket's board status — e.g. a plan-review-gate pass on a Grooming ticket shows the
   *  review Eye while it runs. 'chat' = the persistent per-ticket conversation (no phase glyph). */
  phase?: 'grooming' | 'implementation' | 'review' | 'finalize' | 'fast-path' | 'chat';
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  groupId?: string;
  groupSeq?: number;
  groupTotal?: number;
  groupType?: ExecutionPattern;
  groupVariant?: GroupVariant;
  /** True when this session can be continued via `claude --resume` (FLUX-606). */
  resumable?: boolean;
  /** FLUX-1390: ISO time a `scheduled` (sleeping) session will be auto-resumed via `--resume`. */
  wakeAt?: string;
  /** FLUX-1390: the agent's own reason for the pending wakeup, if it gave one. */
  wakeReason?: string;
  /** FLUX-1434: `event-horizon` MCP tool names (bare) disallowed for this session at its last
   *  spawn/resume — the deny-list model's computed output, read-only. Absent/empty = unscoped. */
  disallowedEhTools?: string[];
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

/** FLUX-1261: per-gate autonomy dial value. `auto` loops to completion with no human click;
 *  `you` always waits for a human. `merge` is never a representable gate — structural lock.
 *  `auto-then-you` is asymmetric across gates (FLUX-1288): the `plan` gate loops review → revise
 *  until approved, then always flags a human to confirm the move to Todo (only the terminal action
 *  is manual); the `review` gate instead runs exactly one automated pass and always stops, win or
 *  lose (it never loops on its own). */
export type GateValue = 'auto' | 'auto-then-you' | 'you';
/** The two gates with a dial in v1 — `plan` (Grooming → Todo) and `review` (→ Ready). */
export type GateName = 'plan' | 'review';

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
  /** FLUX-1261: per-gate autonomy policy — `plan` (Grooming) and `review` (Ready) each dial
   *  Auto / Auto→You / You. Replaces Temper's (FLUX-1071) board-wide `temperEnabled` boolean;
   *  `review: 'auto'` drives the exact loop `temperEnabled: true` used to. Edited from the ⚙ on
   *  the Grooming/Ready columns. `merge` is never a representable key — the merge-lock is
   *  structural, not a runtime check. */
  gatePolicy?: {
    boardDefault: Record<GateName, GateValue>;
  };
  /** FLUX-1263: column-level fixed override for the `plan` gate's review depth. `'auto'` (default) picks
   *  Quick/Standard/Thorough from the ticket's effort; a fixed value forces that depth for every plan
   *  review regardless of effort. Dialed in the same Grooming-column ⚙ modal as `gatePolicy`. */
  planReviewDepth?: 'auto' | 'quick' | 'standard' | 'thorough';
  /** FLUX-1379: deterministic pre-gate plan lint (`engine/src/models/plan-lint.ts`) — bounces
   *  mechanical plan defects for free in the `change_status` guard, before any LLM review session
   *  spawns. Default `true`. Dialed in the same Grooming-column ⚙ modal as `gatePolicy`. */
  planLint?: boolean;
  /** FLUX-1379: XS/S tickets auto-skip the automatic `plan` gate trigger by default (a review can't
   *  pay for itself on a ticket that small). Default `true`. Lint (above) still runs regardless.
   *  Dialed in the same Grooming-column ⚙ modal as `gatePolicy`. */
  planGateSkipSmall?: boolean;
  /** FLUX-1290: gates the `finish_ticket` merge-lock's runtime "a human touched this" check.
   *  Default `false` — an agent session can merge a branch/PR ticket with no prior human touch;
   *  `true` restores the always-on refusal. A plain on/off switch, not a `gatePolicy` key — dialed
   *  in the same Ready-column ⚙ modal (review gate) as `gatePolicy`. */
  blockAgentPrMerges?: boolean;
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
      /** FLUX-1373: what each spend tier resolves to for this CLI. Blank = shipped default. */
      tiers?: { smart?: string; efficient?: string; cheap?: string };
    };
    geminiCli?: {
      tiers?: { smart?: string; efficient?: string; cheap?: string };
    };
    /** FLUX-1373: was silently dropped by the narrower type before — Copilot never had a model card. */
    copilotCli?: {
      tiers?: { smart?: string; efficient?: string; cheap?: string };
    };
  };
  /** FLUX-1373: task -> tier policy. `preset` is 'custom' whenever `assignments` diverges from all
   *  three named presets (Splurge/Balanced/Frugal); editing any assignment flips it to 'custom'. */
  modelPolicy?: {
    preset: ModelPreset;
    assignments: Record<TaskKey, Tier>;
  };
  defaultAgent?: CliFramework | 'auto';
  // ─── FLUX-906: served by /api/config so the portal stops hardcoding Claude ───
  /** Per-framework capability table (engine `CLI_CAPABILITIES`). The UI gates features off
   *  these flags instead of `framework === 'claude'` — see `frameworkSupports()` in utils.ts. */
  cliCapabilities?: Record<CliFramework, CliCapabilities>;
  /** The engine-resolved `'auto'` framework (`resolveDefaultFramework()`), already concrete.
   *  Pass THIS to `resolveEffectiveAgent`, not `defaultAgent` (which may be the `'auto'` sentinel). */
  defaultFramework?: CliFramework;
  /** The orchestrator-chat sentinel (`BOARD_CONVERSATION_ID`). The portal keeps a sync constant
   *  in api.ts (needed at module-eval); this lets it be cross-checked against the engine. */
  boardConversationId?: string;
  /** FLUX-1209: the Furnace Operator ("Smelter") chat sentinel (`FURNACE_CONVERSATION_ID`) — same
   *  cross-check contract as `boardConversationId` above. */
  furnaceConversationId?: string;
  /** FLUX-907 (split semantics): the frameworks EH can actually LAUNCH (the runtime adapter registry).
   *  Narrower than the skill installer's framework list — the UI badges install-only frameworks
   *  "Skills only". See `isRuntimeFramework()` in utils.ts. */
  runtimeFrameworks?: CliFramework[];
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
  furnaceSettings?: {
    rateLimitRetryIntervalMs: number;
    rateLimitMaxWaitMs: number;
    /** FLUX-1175: the Smelter persona's authority mode — 'drafting' (manual, default: every
     *  real burn-lifecycle action needs confirmation) vs 'operator' (autonomous full authority
     *  once asked to manage a burn). */
    smelterMode?: 'drafting' | 'operator';
  };
  agents?: {
    /** FLUX-1390: opt-in — honor `ScheduleWakeup` in unattended dispatched (non-chat) phase sessions
     *  instead of blocking it (FLUX-1389's default). A session that calls it enters the `scheduled`
     *  session state and is auto-resumed via `--resume` once its wakeAt passes. Default false. */
    honorScheduledWakeups?: boolean;
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
  terminalCommands?: TerminalCommand[];
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

export interface TerminalSessionInfo {
  id: string;
  title: string;
  status: 'running' | 'exited';
  cols: number;
  rows: number;
  cwd: string;
  createdAt: string;
}

export interface TerminalCommand {
  id: string;
  label: string;
  command: string;
  runMode: 'current' | 'new';
}

export type OperationKind = 'git' | 'gh' | 'spawn' | 'handshake';
export type OperationOutcome = 'ok' | 'timeout' | 'error' | 'aborted';

/** Client-side mirror of engine/src/operation-telemetry.ts's `OperationEvent` (S9, FLUX-1005). */
export interface OperationEvent {
  opId: string;
  kind: OperationKind;
  ticketId?: string;
  sessionId?: string;
  cmd: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  outcome: OperationOutcome;
  reason?: string;
}

