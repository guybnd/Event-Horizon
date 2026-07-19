import type { ColumnLiveEvent, Config, Task, TaskLiveEvent } from '../types';
import type { ParseError, Notification, WorkspaceInfo, WorktreeInfo } from '../api';
import type { BatchTicket } from '../furnaceTypes';

export type AppView = 'board' | 'backlog' | 'docs' | 'settings' | 'releases' | 'workflows' | 'changes' | 'epics' | 'token-costs' | 'dev-onboarding';
export type TaskSortOption = 'default' | 'priority' | 'updated' | 'assignee';
export type AppTheme = 'light' | 'dark' | 'matrix' | 'cyber' | 'midnight';

/**
 * FLUX-1540: real cold-boot scan progress, fed by the engine's `bootProgress` SSE event (emitted
 * from `initDir`'s existing 50-file yield boundary). `null` until the first event arrives — the
 * loading state falls back to an indeterminate animation in that case (event missed, or the scan
 * finished before the portal connected).
 */
export interface BootProgress {
  loaded: number;
  total: number;
  // FLUX-1547 Phase 4: kept as a bare `string`, not an exhaustive literal union — the engine may
  // introduce additional phase values (e.g. a `'cached'` fast-path) independently of the portal,
  // and nothing here switches on the literal value, only `loaded`/`total`. Widening avoids a
  // false sense of exhaustiveness and keeps an unrecognized value from ever being a type error.
  phase: string;
}

/**
 * S10 (epic FLUX-996): the detail behind a `'failed'`/timed-out spawn — mirrors the engine's
 * `OperationEvent` (operation-telemetry.ts) but only the fields the card needs to explain WHY.
 * Scoped by `sessionId` so a stale failure from a PRIOR session never outlives a fresh retry:
 * consumers should only trust this when it matches the task's CURRENT `cliSession.id`.
 */
export interface OperationFailure {
  sessionId?: string;
  kind: 'git' | 'gh' | 'spawn' | 'handshake';
  reason?: string;
  endedAt: number;
}

/**
 * Per-task fast-moving session state, isolated from the `tasks` array so that
 * activity/progress SSE ticks during a live agent session don't churn `tasks`
 * identity and re-render the whole board (FLUX-626). Populated by SSE handlers.
 */
export interface LiveSession {
  currentActivity?: string;
  liveOutput?: string;
  status?: string;
  /** Streamed progress entries for the active agent_session, keyed by sessionId. */
  progressBySession?: Record<string, Array<{ timestamp: string; message: string }>>;
  /** S10: the most recent non-'ok' spawn operation for this task, fed by the SSE `operation`
   *  event — the richest available detail on WHY the session failed (kind/reason). */
  lastOperationFailure?: OperationFailure;
}

/**
 * One engine SSE event captured for the terminal's Engine-events log (FLUX-1030). Lives in the
 * store — not in the terminal component — so it accumulates from app boot and survives the panel
 * being minimized/closed/reopened. Fed from the single `/api/events` connection in AppContext via
 * the generic `eh-event` channel, so every engine event type is captured (no client allowlist).
 */
export interface EngineEvent {
  /** Monotonic counter assigned at arrival (FLUX-1138) — stable across the capped ring buffer
   *  shifting, so consumers can key rows on it instead of array index. */
  id: number;
  type: string;
  data: unknown;
  timestamp: number;
}

/** Ring-buffer cap for the Engine-events log — bounds memory over a long-lived session. */
export const ENGINE_EVENTS_MAX = 2000;

/**
 * S9 (epic FLUX-1230): the board-scoped subset of {@link AppStoreState} — every field that must
 * NOT leak across boards once the portal addresses more than one. Keyed by board id (the
 * workspace's absolute root path) in `boardsById`. For S9 only the active board's slice is
 * populated (a pure projection of the existing flat fields/hooks); S10 is what actually caches a
 * second board's slice for non-destructive switching.
 */
export interface BoardSlice {
  tasks: Task[];
  taskById: Map<string, Task>;
  prByBranch: Map<string, string>;
  prMemberIds: Set<string>;
  worktreeBranches: Set<string>;
  worktrees: WorktreeInfo[];
  liveSessions: Record<string, LiveSession>;
  engineEvents: EngineEvent[];
  taskLiveEvents: Record<string, TaskLiveEvent>;
  columnLiveEvents: Record<string, ColumnLiveEvent>;
  pinnedTasks: Record<string, number>;
  readComments: Record<string, string[]>;
  notifications: Notification[];
  config: Config | null;
}

/**
 * The pure-data half of the app state. Functions/actions live in {@link AppActions}
 * and are exposed via a stable `useAppActions()` so action-only consumers never
 * re-render. This object is read through `useAppSelector` so each consumer
 * subscribes only to the slice it selects (FLUX-625).
 */
export interface AppStoreState {
  /** S9: board key (workspace absolute path) of the currently active board, or `null` before the
   *  first workspace resolves. Also the key `ehFetch` (api.ts) threads onto every board-scoped
   *  request and the SSE subscription uses to scope its stream. */
  activeBoardId: string | null;
  /** S9: per-board slice cache, keyed by `activeBoardId`'s board key. Only the active board's
   *  entry is populated today — see {@link BoardSlice}. */
  boardsById: Record<string, BoardSlice>;
  currentUser: string;
  currentProject: string;
  searchQuery: string;
  sortOption: TaskSortOption;
  filterAssignee: string;
  filterPriority: string;
  filterTag: string;
  filterUnreadOnly: boolean;
  /** '' = off, 'any' = any worktree, '<branch>' = isolate the board to that one worktree. */
  filterWorktree: string;
  view: AppView;
  settingsTab: string | null;
  modalTask: Partial<Task> | null;
  isModalOpen: boolean;
  /** FLUX-1507: the clicked card's rect at the moment the center modal was opened from one — the
   *  origin TaskModal springs its card→modal morph from. Plain object (not a live `DOMRect`) so
   *  it's cheap to compare/store; `null` when the modal was opened without a card (new-task
   *  button, search result, subtask link, …), in which case TaskModal falls back to a plain fade. */
  modalOriginRect: { left: number; top: number; width: number; height: number } | null;
  /** True while a blocking overlay (e.g. the orchestration launcher) is open. */
  isOverlayOpen: boolean;
  openModalScrollToComments: boolean;
  openModalInFullView: boolean;
  tasks: Task[];
  taskById: Map<string, Task>;
  /** branch → PR ticket id, for the `→ PR-n` pile marker on linked-but-unfolded tickets. */
  prByBranch: Map<string, string>;
  /** Ids folded into a PR deck (every PR's members) — PR membership wins over epic folding (FLUX-580). */
  prMemberIds: Set<string>;
  /** Reverse of `prMemberIds` (FLUX-1503): PR member ticket id → its owning PR ticket id. Powers
   *  the "in PR-n" tooltip on an epic subtask that is ALSO folded into a PR's deck. */
  prTicketIdByMember: Map<string, string>;
  /** Every task id → its first epic parent (FLUX-1553), hoisted here so per-card consumers
   *  (PrDeckSection, Board) share one `resolveParentByChildId` computation per `tasks` update
   *  instead of each running their own full-collection sort. */
  parentByChildId: Map<string, Task>;
  /** Branches that currently have a live git worktree (FLUX-516) — powers badges + filter. */
  worktreeBranches: Set<string>;
  worktrees: WorktreeInfo[];
  /** Fast-moving live session state, keyed by task id (FLUX-626). */
  liveSessions: Record<string, LiveSession>;
  /** FLUX-1503: Furnace batch-ticket state, keyed by ticket id — flattened from every known
   *  `FurnaceBatch.tickets` (initial load + `furnace-updated`/`furnace-deleted` SSE). Enriches the
   *  member-state selector (parked/failed/attempts) for tickets folded under a PR or epic deck. */
  furnaceTicketById: Record<string, BatchTicket>;
  /** FLUX-1539: which batch (id/icon/title) each ticket belongs to — populated/pruned alongside
   *  `furnaceTicketById`. Powers the card's batch icon badge + border tint. */
  furnaceBatchMetaByTicketId: Record<string, { batchId: string; icon?: string; title: string }>;
  /** Bounded log of engine SSE events for the terminal's Engine-events tab (FLUX-1030). */
  engineEvents: EngineEvent[];
  /** Pending focus for the Changes view (a branch ref) when opened via a board click-through. */
  changesFocus: string | null;
  tasksLoading: boolean;
  /** FLUX-1540: latest engine `bootProgress` SSE event — see {@link BootProgress}. */
  bootProgress: BootProgress | null;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  columnLiveEvents: Record<string, ColumnLiveEvent>;
  /** FLUX-1300: task id → epoch ms until which it should sort first in its column regardless of
   *  the configured sort option — a temporary "just created" top-pin so a new ticket doesn't get
   *  buried under swimlane-stacked cards. Expires client-side (no server write). */
  pinnedTasks: Record<string, number>;
  refreshTrigger: number;
  lastRefreshAt: number | null;
  isWindowVisible: boolean;
  isConnected: boolean;
  workspaceConfigured: boolean;
  workspacePath: string | null;
  workspaces: WorkspaceInfo[];
  config: Config | null;
  readComments: Record<string, string[]>;
  totalUnreadCount: number;
  theme: AppTheme;
  parseErrors: ParseError[];
  parseErrorsLoading: boolean;
  notifications: Notification[];
  notificationUnreadCount: number;
  restartPending: boolean;
  /** Reactive mirror of the `eh-onboarding-complete` localStorage flag (FLUX-758).
   *  App gates the wizard on this so Skip/Complete dismiss without a manual reload. */
  onboardingComplete: boolean;
}

/**
 * The action half of the app state — a stable, frozen handler set exposed via
 * `useAppActions()`. Identities never change, so action-only consumers (header
 * nav, buttons) never re-render on data updates.
 */
export interface AppActions {
  setCurrentUser: (user: string) => void;
  setCurrentProject: (proj: string) => void;
  setSearchQuery: (query: string) => void;
  setSortOption: (option: TaskSortOption) => void;
  setFilterAssignee: (value: string) => void;
  setFilterPriority: (value: string) => void;
  setFilterTag: (value: string) => void;
  setFilterUnreadOnly: (value: boolean) => void;
  setFilterWorktree: (value: string) => void;
  clearTaskFilters: () => void;
  setView: (view: AppView) => void;
  setSettingsTab: (tab: string | null) => void;
  setModalTask: (task: Partial<Task> | null) => void;
  pushOverlay: () => void;
  popOverlay: () => void;
  closeModal: () => void;
  openTaskModal: (task?: Partial<Task>, from?: HTMLElement | null) => void;
  openTaskFullView: (task: Partial<Task>, options?: { scrollToComments?: boolean }, from?: HTMLElement | null) => void;
  /** Open a task respecting the boardCardOpenMode preference (full view vs modal). */
  openTask: (task: Task) => void;
  clearOpenModalScrollToComments: () => void;
  refreshWorktrees: () => void;
  setChangesFocus: (v: string | null) => void;
  triggerRefresh: () => Promise<void>;
  subscribeToEvent: (eventType: string, handler: (data: unknown) => void) => () => void;
  notifyWorkspaceSet: () => void;
  switchWorkspace: (path: string) => Promise<void>;
  refreshWorkspaces: () => void;
  /** S10 (epic FLUX-1230): non-destructively flip the board-key dimension (store + api.ts's
   *  `ehFetch`/SSE key) to the already-open board `key` and refetch its data — no `/workspaces/
   *  switch` call, no session kill. `key` must already be open (`WorkspaceInfo.open`); use
   *  `openBoard` for a registered-but-not-open board. */
  setActiveBoard: (key: string) => void;
  /** S10: bring a registered-but-not-live board online via the engine registry (`POST /workspaces/
   *  open`), then flip the active board to it via `setActiveBoard`. */
  openBoard: (path: string) => Promise<void>;
  /** S10: evict an open, registry-backed board (`WorkspaceInfo.closable`). Confirms via `useConfirm`
   *  before stopping live sessions unless `force` is already set. */
  closeBoard: (path: string, force?: boolean) => Promise<void>;
  saveConfig: (updates: Config) => Promise<void>;
  ensureReadStateLoaded: (ticketId: string) => void;
  markCommentRead: (ticketId: string, commentId: string) => void;
  markAllCommentsRead: (ticketId: string, commentIds: string[]) => void;
  setAppTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  refreshNotifications: () => void;
  /** Persist the onboarding-complete flag and flip the reactive store field (FLUX-758). */
  markOnboardingComplete: () => void;
  /** Clear the terminal Engine-events log (FLUX-1030) — clears the shared buffer. */
  clearEngineEvents: () => void;
  /** FLUX-1505: merge `patch` onto the live task `taskId` in the store's `tasks` array immediately
   *  — no refetch. Used for optimistic button actions (instant commit, then reconciled/rolled back)
   *  and for patch-first SSE/mutation-response updates (skip the full-list refetch on the hot path).
   *  FLUX-1528: `patch` may also be an updater `(current) => Partial<Task>` so a caller can guard a
   *  delayed revert against whatever landed on the task in the meantime (e.g. don't stomp a real
   *  session that arrived after a ghost-launch failure was scheduled to dissolve). */
  patchTaskLocal: (taskId: string, patch: Partial<Task> | ((current: Task) => Partial<Task>)) => void;
  /** FLUX-1505: mark `taskId` as having just rolled back an optimistic change — the card plays a
   *  brief shake (see `TaskLiveEvent.kind === 'rollback'`) instead of a success animation. */
  emitTaskRollback: (taskId: string) => void;
}

function createInitialState(): AppStoreState {
  return {
    // FLUX-785: pre-hydration value only (AppContext's snapshot overwrites it once mounted).
    // Read the persisted identity if present, else a neutral 'You' — never the maintainer's name.
    currentUser: (typeof localStorage !== 'undefined' && localStorage.getItem('eh-current-user')) || 'You',
    activeBoardId: null,
    boardsById: {},
    currentProject: '',
    searchQuery: '',
    sortOption: 'default',
    filterAssignee: 'all',
    filterPriority: 'all',
    filterTag: 'all',
    filterUnreadOnly: false,
    filterWorktree: '',
    view: 'board',
    settingsTab: null,
    modalTask: null,
    isModalOpen: false,
    modalOriginRect: null,
    isOverlayOpen: false,
    openModalScrollToComments: false,
    openModalInFullView: false,
    tasks: [],
    taskById: new Map(),
    prByBranch: new Map(),
    prMemberIds: new Set(),
    prTicketIdByMember: new Map(),
    parentByChildId: new Map(),
    worktreeBranches: new Set(),
    worktrees: [],
    liveSessions: {},
    furnaceTicketById: {},
    furnaceBatchMetaByTicketId: {},
    engineEvents: [],
    changesFocus: null,
    tasksLoading: true,
    bootProgress: null,
    taskLiveEvents: {},
    columnLiveEvents: {},
    pinnedTasks: {},
    refreshTrigger: 0,
    lastRefreshAt: null,
    isWindowVisible: true,
    isConnected: true,
    workspaceConfigured: false,
    workspacePath: null,
    workspaces: [],
    config: null,
    readComments: {},
    totalUnreadCount: 0,
    theme: 'matrix',
    parseErrors: [],
    parseErrorsLoading: false,
    notifications: [],
    notificationUnreadCount: 0,
    restartPending: false,
    onboardingComplete:
      typeof localStorage !== 'undefined' && localStorage.getItem('eh-onboarding-complete') === '1',
  };
}

let state: AppStoreState = createInitialState();
const listeners = new Set<() => void>();

/** Shallow per-field equality over the snapshot. Maps/Sets/arrays compare by
 *  reference — the provider memoizes them, so a reference match means no change. */
function shallowEqualState(a: AppStoreState, b: AppStoreState): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof AppStoreState>;
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * External store backing the app state. The AppProvider owns the effects and
 * mirrors React state into here; consumers read via `useAppSelector`.
 */
export const appStore = {
  getState(): AppStoreState {
    return state;
  },
  /** Replace the whole snapshot. No-ops (and skips notifying) when nothing changed. */
  setState(next: AppStoreState) {
    if (shallowEqualState(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  },
  /** Patch a subset of fields. Used by SSE handlers that touch a single slice. */
  patch(partial: Partial<AppStoreState>) {
    appStore.setState({ ...state, ...partial });
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** S9: the active board's slice, or `null` before a board has resolved / before it's been
 *  populated. Consumers that need cross-board isolation (S10's switcher) read through this
 *  instead of the flat `AppStoreState` fields directly. */
export function getActiveBoardSlice(state: AppStoreState): BoardSlice | null {
  if (!state.activeBoardId) return null;
  return state.boardsById[state.activeBoardId] ?? null;
}
