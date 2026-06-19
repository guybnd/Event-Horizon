import type { ColumnLiveEvent, Config, Task, TaskLiveEvent } from '../types';
import type { ParseError, Notification, WorkspaceInfo, WorktreeInfo } from '../api';

export type AppView = 'board' | 'backlog' | 'docs' | 'settings' | 'releases' | 'workflows' | 'changes';
export type TaskSortOption = 'default' | 'priority' | 'updated' | 'assignee';
export type AppTheme = 'light' | 'dark' | 'matrix' | 'cyber' | 'midnight';

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
}

/**
 * The pure-data half of the app state. Functions/actions live in {@link AppActions}
 * and are exposed via a stable `useAppActions()` so action-only consumers never
 * re-render. This object is read through `useAppSelector` so each consumer
 * subscribes only to the slice it selects (FLUX-625).
 */
export interface AppStoreState {
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
  /** Branches that currently have a live git worktree (FLUX-516) — powers badges + filter. */
  worktreeBranches: Set<string>;
  worktrees: WorktreeInfo[];
  /** Fast-moving live session state, keyed by task id (FLUX-626). */
  liveSessions: Record<string, LiveSession>;
  /** Pending focus for the Changes view (a branch ref) when opened via a board click-through. */
  changesFocus: string | null;
  tasksLoading: boolean;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  columnLiveEvents: Record<string, ColumnLiveEvent>;
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
  openTaskModal: (task?: Partial<Task>) => void;
  openTaskFullView: (task: Partial<Task>, options?: { scrollToComments?: boolean }) => void;
  clearOpenModalScrollToComments: () => void;
  refreshWorktrees: () => void;
  setChangesFocus: (v: string | null) => void;
  triggerRefresh: () => void;
  subscribeToEvent: (eventType: string, handler: (data: unknown) => void) => () => void;
  notifyWorkspaceSet: () => void;
  switchWorkspace: (path: string) => Promise<void>;
  refreshWorkspaces: () => void;
  saveConfig: (updates: Config) => Promise<void>;
  ensureReadStateLoaded: (ticketId: string) => void;
  markCommentRead: (ticketId: string, commentId: string) => void;
  markAllCommentsRead: (ticketId: string, commentIds: string[]) => void;
  setAppTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  refreshNotifications: () => void;
}

function createInitialState(): AppStoreState {
  return {
    currentUser: 'Guy',
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
    isOverlayOpen: false,
    openModalScrollToComments: false,
    openModalInFullView: false,
    tasks: [],
    taskById: new Map(),
    prByBranch: new Map(),
    prMemberIds: new Set(),
    worktreeBranches: new Set(),
    worktrees: [],
    liveSessions: {},
    changesFocus: null,
    tasksLoading: true,
    taskLiveEvents: {},
    columnLiveEvents: {},
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
