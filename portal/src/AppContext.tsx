import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ColumnLiveEvent, Config, Task, TaskLiveEvent } from './types';
import { fetchConfig, fetchTasks, fetchWorktrees, fetchHealth, saveConfig as apiSaveConfig, fetchReadState, saveReadState, fetchWorkspace, fetchParseErrors, fetchNotifications, fetchWorkspaces, switchWorkspace as apiSwitchWorkspace, type ParseError, type Notification, type WorkspaceInfo, type WorktreeInfo } from './api';
import { getArchiveStatus } from './workflow';

export type AppView = 'board' | 'backlog' | 'docs' | 'settings' | 'releases' | 'workflows' | 'changes';
export type TaskSortOption = 'default' | 'priority' | 'updated' | 'assignee';
export type AppTheme = 'light' | 'dark' | 'matrix' | 'cyber' | 'midnight';

export interface ThemeDef {
  name: AppTheme;
  label: string;
  baseMode: 'light' | 'dark';
}

export const THEMES: ThemeDef[] = [
  { name: 'light', label: 'Light', baseMode: 'light' },
  { name: 'dark', label: 'Dark', baseMode: 'dark' },
  { name: 'matrix', label: 'Matrix', baseMode: 'dark' },
  { name: 'cyber', label: 'Cyber', baseMode: 'dark' },
  { name: 'midnight', label: 'Midnight', baseMode: 'dark' },
];

const VALID_THEMES = new Set<string>(THEMES.map(t => t.name));

function getInitialTheme(): AppTheme {
  const stored = localStorage.getItem('eh-theme');
  if (stored && VALID_THEMES.has(stored)) return stored as AppTheme;
  return 'matrix';
}

function applyTheme(theme: AppTheme) {
  const def = THEMES.find(t => t.name === theme)!;
  document.documentElement.classList.toggle('dark', def.baseMode === 'dark');
  document.documentElement.setAttribute('data-theme', theme);
}

const VIEW_PATHS: Record<AppView, string> = {
  board: '/board',
  backlog: '/backlog',
  changes: '/changes',
  docs: '/docs',
  settings: '/settings',
  releases: '/releases',
  workflows: '/workflows',
};

const LIVE_TASK_POLL_INTERVAL_MS = 3000;
const LIVE_EVENT_DURATION_MS = 2200;

function normalizeTaskList(tasks: Task[]) {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}

function buildTaskSignature(task: Task) {
  const history = task.history || [];
  const lastEntry = history[history.length - 1];
  return JSON.stringify({
    id: task.id,
    status: task.status,
    title: task.title || '',
    bodyLen: (task.body || '').length,
    bodyHead: (task.body || '').slice(0, 200),
    assignee: task.assignee || 'unassigned',
    priority: task.priority || 'None',
    effort: task.effort || 'None',
    implementationLink: task.implementationLink || '',
    order: task.order ?? null,
    tags: task.tags || [],
    subtasks: task.subtasks || [],
    historyLen: history.length,
    historyLast: lastEntry ? (lastEntry.date || '') + (lastEntry.type || '') : null,
    sessionStatus: task.cliSession?.status ?? null,
    sessionActivity: task.cliSession?.currentActivity ?? null,
    sessionLabel: task.cliSession?.label ?? null,
    tokenMetadata: task.tokenMetadata ?? null,
  });
}

function removeKey<TValue>(record: Record<string, TValue>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function getViewFromLocation(): AppView {
  const path = window.location.pathname.toLowerCase();
  if (path === '/backlog') return 'backlog';
  if (path === '/changes') return 'changes';
  if (path === '/docs') return 'docs';
  if (path === '/settings') return 'settings';
  if (path === '/releases') return 'releases';
  if (path === '/workflows') return 'workflows';
  return 'board';
}

function updateViewUrl(view: AppView, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  url.pathname = VIEW_PATHS[view];
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
}

function getTaskFiltersFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    searchQuery: params.get('search') || '',
    sortOption: (params.get('sort') as TaskSortOption) || 'default',
    filterAssignee: params.get('assignee') || 'all',
    filterPriority: params.get('priority') || 'all',
    filterTag: params.get('tag') || 'all',
    filterUnreadOnly: params.get('unread') === '1',
    // '' = off, 'any' = any worktree, '<branch>' = isolate to that one worktree.
    filterWorktree: params.get('worktree') || '',
  };
}

function updateTaskFilterUrl(filters: {
  searchQuery: string;
  sortOption: TaskSortOption;
  filterAssignee: string;
  filterPriority: string;
  filterTag: string;
  filterUnreadOnly: boolean;
  filterWorktree: string;
}) {
  const url = new URL(window.location.href);
  const entries: Array<[string, string, string]> = [
    ['search', filters.searchQuery, ''],
    ['sort', filters.sortOption, 'default'],
    ['assignee', filters.filterAssignee, 'all'],
    ['priority', filters.filterPriority, 'all'],
    ['tag', filters.filterTag, 'all'],
    ['unread', filters.filterUnreadOnly ? '1' : '', ''],
    ['worktree', filters.filterWorktree, ''],
  ];

  entries.forEach(([key, value, fallback]) => {
    if (!value || value === fallback) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  });

  window.history.replaceState({}, '', url);
}

interface AppState {
  currentUser: string;
  setCurrentUser: (user: string) => void;
  currentProject: string;
  setCurrentProject: (proj: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortOption: TaskSortOption;
  setSortOption: (option: TaskSortOption) => void;
  filterAssignee: string;
  setFilterAssignee: (value: string) => void;
  filterPriority: string;
  setFilterPriority: (value: string) => void;
  filterTag: string;
  setFilterTag: (value: string) => void;
  filterUnreadOnly: boolean;
  setFilterUnreadOnly: (value: boolean) => void;
  /** '' = off, 'any' = any worktree, '<branch>' = isolate the board to that one worktree. */
  filterWorktree: string;
  setFilterWorktree: (value: string) => void;
  clearTaskFilters: () => void;
  view: AppView;
  setView: (view: AppView) => void;
  settingsTab: string | null;
  setSettingsTab: (tab: string | null) => void;
  modalTask: Partial<Task> | null;
  setModalTask: (task: Partial<Task> | null) => void;
  isModalOpen: boolean;
  /** True while a blocking overlay (e.g. the orchestration launcher) is open. Board hover popups are suppressed while set. */
  isOverlayOpen: boolean;
  pushOverlay: () => void;
  popOverlay: () => void;
  closeModal: () => void;
  openTaskModal: (task?: Partial<Task>) => void;
  openTaskFullView: (task: Partial<Task>, options?: { scrollToComments?: boolean }) => void;
  openModalScrollToComments: boolean;
  clearOpenModalScrollToComments: () => void;
  openModalInFullView: boolean;
  tasks: Task[];
  taskById: Map<string, Task>;
  /** Branches that currently have a live git worktree (FLUX-516) — powers badges + filter. */
  worktreeBranches: Set<string>;
  worktrees: WorktreeInfo[];
  /** Re-fetch the active worktrees immediately (e.g. right after a detach). */
  refreshWorktrees: () => void;
  /** Pending focus for the Changes view (a branch ref) when opened via a board click-through. */
  changesFocus: string | null;
  setChangesFocus: (v: string | null) => void;
  tasksLoading: boolean;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  columnLiveEvents: Record<string, ColumnLiveEvent>;
  refreshTrigger: number;
  triggerRefresh: () => void;
  lastRefreshAt: number | null;
  isWindowVisible: boolean;
  isConnected: boolean;
  workspaceConfigured: boolean;
  workspacePath: string | null;
  notifyWorkspaceSet: () => void;
  workspaces: WorkspaceInfo[];
  switchWorkspace: (path: string) => Promise<void>;
  refreshWorkspaces: () => void;
  config: Config | null;
  saveConfig: (updates: Config) => Promise<void>;
  readComments: Record<string, string[]>;
  totalUnreadCount: number;
  ensureReadStateLoaded: (ticketId: string) => void;
  markCommentRead: (ticketId: string, commentId: string) => void;
  markAllCommentsRead: (ticketId: string, commentIds: string[]) => void;
  theme: AppTheme;
  setAppTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  parseErrors: ParseError[];
  parseErrorsLoading: boolean;
  notifications: Notification[];
  notificationUnreadCount: number;
  refreshNotifications: () => void;
  restartPending: boolean;
}

// Keep the selected project key in sync with the active workspace's config.
// If the previous selection is still valid for this workspace, keep it;
// otherwise adopt the workspace's first project. This prevents a stale key
// (e.g. from a previously open workspace) leaking into new tickets.
function reconcileProject(prev: string, projects: string[] | undefined): string {
  const list = projects ?? [];
  if (prev && list.includes(prev)) return prev;
  return list[0] || 'PROJECT';
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const initialFilters = getTaskFiltersFromLocation();
  const [currentUser, setCurrentUser] = useState('Guy');
  const [currentProject, setCurrentProject] = useState('');
  const [searchQuery, setSearchQuery] = useState(initialFilters.searchQuery);
  const [sortOption, setSortOption] = useState<TaskSortOption>(initialFilters.sortOption);
  const [filterAssignee, setFilterAssignee] = useState(initialFilters.filterAssignee);
  const [filterPriority, setFilterPriority] = useState(initialFilters.filterPriority);
  const [filterTag, setFilterTag] = useState(initialFilters.filterTag);
  const [filterUnreadOnly, setFilterUnreadOnly] = useState(initialFilters.filterUnreadOnly);
  const [filterWorktree, setFilterWorktree] = useState(initialFilters.filterWorktree);
  const [view, setCurrentView] = useState<AppView>(() => getViewFromLocation());
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
  const [modalTask, setModalTask] = useState<Partial<Task> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [overlayCount, setOverlayCount] = useState(0);
  const pushOverlay = useCallback(() => setOverlayCount((n) => n + 1), []);
  const popOverlay = useCallback(() => setOverlayCount((n) => Math.max(0, n - 1)), []);
  const [openModalScrollToComments, setOpenModalScrollToComments] = useState(false);
  const [openModalInFullView, setOpenModalInFullView] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Branches that currently hold a worktree — refreshed whenever tasks change
  // (a worktree create/detach broadcasts taskUpdated → loadTasks → this) (FLUX-516).
  const [worktreeBranches, setWorktreeBranches] = useState<Set<string>>(new Set());
  // Full worktree list (path, branch, ticket, changedFiles count) — drives the
  // card change-count badge and the worktrees panel; the Set is its branch index.
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const refreshWorktrees = useCallback(() => {
    fetchWorktrees()
      .then((ws) => {
        setWorktrees(ws);
        setWorktreeBranches(new Set(ws.map((w) => w.branch)));
      })
      .catch(() => {});
  }, []);
  useEffect(() => { refreshWorktrees(); }, [tasks, refreshWorktrees]);
  // Pending focus (a branch) for the Changes view when navigated from a board click-through.
  const [changesFocus, setChangesFocus] = useState<string | null>(null);
  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskLiveEvents, setTaskLiveEvents] = useState<Record<string, TaskLiveEvent>>({});
  const [columnLiveEvents, setColumnLiveEvents] = useState<Record<string, ColumnLiveEvent>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [isWindowVisible, setIsWindowVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));
  const [isConnected, setIsConnected] = useState(true);
  const [workspaceConfigured, setWorkspaceConfigured] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [readComments, setReadComments] = useState<Record<string, string[]>>({});
  const [theme, setTheme] = useState<AppTheme>(() => {
    const initial = getInitialTheme();
    applyTheme(initial);
    return initial;
  });
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const [parseErrorsLoading] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [restartPending, setRestartPending] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const readCommentsLoadedRef = useRef(false);
  const configRef = useRef<Config | null>(null);
  const tasksRef = useRef<Task[]>([]);
  const isFetchingTasksRef = useRef(false);
  const hasLoadedTasksRef = useRef(false);
  const taskEventTimeoutsRef = useRef<Record<string, number>>({});
  const columnEventTimeoutsRef = useRef<Record<string, number>>({});
  const liveEventSequenceRef = useRef(0);
  const pendingReadStateRef = useRef<Record<string, string[]>>({});
  const readStateFlushTimerRef = useRef<number | null>(null);

  const scheduleTaskEventClear = useCallback((taskId: string, sequence: number) => {
    const existingTimeout = taskEventTimeoutsRef.current[taskId];
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    taskEventTimeoutsRef.current[taskId] = window.setTimeout(() => {
      setTaskLiveEvents((current) => {
        if (!current[taskId] || current[taskId].sequence !== sequence) {
          return current;
        }

        return removeKey(current, taskId);
      });
      delete taskEventTimeoutsRef.current[taskId];
    }, LIVE_EVENT_DURATION_MS);
  }, []);

  const scheduleColumnEventClear = useCallback((columnId: string, sequence: number) => {
    const existingTimeout = columnEventTimeoutsRef.current[columnId];
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    columnEventTimeoutsRef.current[columnId] = window.setTimeout(() => {
      setColumnLiveEvents((current) => {
        if (!current[columnId] || current[columnId].sequence !== sequence) {
          return current;
        }

        return removeKey(current, columnId);
      });
      delete columnEventTimeoutsRef.current[columnId];
    }, LIVE_EVENT_DURATION_MS);
  }, []);

  const applyLiveEvents = useCallback((nextTaskEvents: Record<string, TaskLiveEvent>, nextColumnEvents: Record<string, ColumnLiveEvent>) => {
    const taskEntries = Object.entries(nextTaskEvents);
    if (taskEntries.length > 0) {
      setTaskLiveEvents((current) => ({ ...current, ...nextTaskEvents }));
      taskEntries.forEach(([taskId, event]) => scheduleTaskEventClear(taskId, event.sequence));
    }

    const columnEntries = Object.entries(nextColumnEvents);
    if (columnEntries.length > 0) {
      setColumnLiveEvents((current) => ({ ...current, ...nextColumnEvents }));
      columnEntries.forEach(([columnId, event]) => scheduleColumnEventClear(columnId, event.sequence));
    }
  }, [scheduleColumnEventClear, scheduleTaskEventClear]);

  const loadTasks = useCallback(async () => {
    if (isFetchingTasksRef.current) {
      return;
    }

    isFetchingTasksRef.current = true;

    if (!hasLoadedTasksRef.current) {
      setTasksLoading(true);
    }

    try {
      const fetchedTasks = normalizeTaskList(await fetchTasks());
      const previousTasks = tasksRef.current;
      const previousTasksById = new Map(previousTasks.map((task) => [task.id, task]));
      const nextTaskEvents: Record<string, TaskLiveEvent> = {};
      const nextColumnEvents: Record<string, ColumnLiveEvent> = {};
      const shouldEmitLiveEvents = previousTasks.length > 0;
      let changed = previousTasks.length !== fetchedTasks.length;

      const nextSequence = () => {
        liveEventSequenceRef.current += 1;
        return liveEventSequenceRef.current;
      };

      for (const task of fetchedTasks) {
        const previousTask = previousTasksById.get(task.id);

        if (!previousTask) {
          changed = true;

          if (shouldEmitLiveEvents) {
            nextTaskEvents[task.id] = {
              kind: 'created',
              sequence: nextSequence(),
              at: Date.now(),
              toStatus: task.status,
            };
            nextColumnEvents[task.status] = {
              kind: 'created',
              sequence: nextSequence(),
              at: Date.now(),
              taskId: task.id,
            };
          }

          continue;
        }

        if (previousTask.status !== task.status) {
          changed = true;

          if (shouldEmitLiveEvents) {
            nextTaskEvents[task.id] = {
              kind: 'moved',
              sequence: nextSequence(),
              at: Date.now(),
              fromStatus: previousTask.status,
              toStatus: task.status,
            };
            nextColumnEvents[task.status] = {
              kind: 'received',
              sequence: nextSequence(),
              at: Date.now(),
              taskId: task.id,
            };
            
            if (task.status.toLowerCase() === 'done') {
              const fireworksEnabled = configRef.current?.enableFireworks !== false;
              const animationsEnabled = configRef.current?.animationsEnabled !== false;
              if (fireworksEnabled && animationsEnabled) {
                import('canvas-confetti').then((module) => {
                  module.default({
                    particleCount: 150,
                    spread: 80,
                    origin: { y: 0.6 }
                  });
                }).catch(console.error);
              }
            }
          }

          continue;
        }

        if (buildTaskSignature(previousTask) !== buildTaskSignature(task)) {
          changed = true;

          if (shouldEmitLiveEvents) {
            nextTaskEvents[task.id] = {
              kind: 'updated',
              sequence: nextSequence(),
              at: Date.now(),
              toStatus: task.status,
            };
          }
        }
      }

      if (!changed) {
        const nextTaskIds = new Set(fetchedTasks.map((task) => task.id));
        changed = previousTasks.some((task) => !nextTaskIds.has(task.id));
      }

      hasLoadedTasksRef.current = true;

      if (!changed && previousTasks.length > 0) {
        startTransition(() => setTasksLoading(false));
        return;
      }

      tasksRef.current = fetchedTasks;
      startTransition(() => {
        setTasksLoading(false);
        setTasks(fetchedTasks);
        setLastRefreshAt(Date.now());
        if (shouldEmitLiveEvents) {
          applyLiveEvents(nextTaskEvents, nextColumnEvents);
        }
      });
    } catch (error) {
      console.error(error);

      if (!hasLoadedTasksRef.current) {
        setTasksLoading(true);
      }
    } finally {
      isFetchingTasksRef.current = false;
    }
  }, [applyLiveEvents]);

  const loadParseErrors = useCallback(async () => {
    if (!workspaceConfigured) return;

    try {
      const errors = await fetchParseErrors();
      setParseErrors(errors);
    } catch (error) {
      console.error('Failed to fetch parse errors:', error);
    }
  }, [workspaceConfigured]);

  const refreshNotifications = useCallback(() => {
    fetchNotifications().then(data => {
      setNotifications(data.notifications);
      setNotificationUnreadCount(data.unreadCount);
    }).catch(() => {});
  }, []);

  const triggerRefresh = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
    void loadTasks();
    void loadParseErrors();
  }, [loadTasks, loadParseErrors]);

  const updateTicketViewUrl = (taskId: string, viewMode: 'popup' | 'full') => {
    const url = new URL(window.location.href);
    url.searchParams.set('ticket', taskId);
    url.searchParams.set('view', viewMode);
    window.history.replaceState({}, '', url);
  };

  const setView = (nextView: AppView) => {
    setCurrentView(nextView);
    updateViewUrl(nextView, 'push');
  };

  const clearTaskFilters = () => {
    setSearchQuery('');
    setSortOption('default');
    setFilterAssignee('all');
    setFilterPriority('all');
    setFilterTag('all');
    setFilterUnreadOnly(false);
    setFilterWorktree('');
  };

  const openTaskModal = (task?: Partial<Task>) => {
    setOpenModalInFullView(false);
    const nextTask = task || { status: 'Todo' };
    if (nextTask.id) {
      updateTicketViewUrl(nextTask.id, 'popup');
    }
    setModalTask(nextTask);
    setIsModalOpen(true);
  };

  const openTaskFullView = (task: Partial<Task>, options?: { scrollToComments?: boolean }) => {
    if (task.id) {
      updateTicketViewUrl(task.id, 'full');
    }
    setModalTask(task);
    setIsModalOpen(true);
    setOpenModalInFullView(true);
    setOpenModalScrollToComments(options?.scrollToComments ?? false);
  };

  const clearOpenModalScrollToComments = () => setOpenModalScrollToComments(false);

  const closeModal = () => {
    setIsModalOpen(false);
    setOpenModalInFullView(false);
    setTimeout(() => setModalTask(null), 1000);
  };

  const setAppTheme = (next: AppTheme) => {
    setTheme(() => {
      applyTheme(next);
      localStorage.setItem('eh-theme', next);
      return next;
    });
  };

  const toggleTheme = () => {
    setTheme((prev) => {
      const idx = THEMES.findIndex(t => t.name === prev);
      const next = THEMES[(idx + 1) % THEMES.length].name;
      applyTheme(next);
      localStorage.setItem('eh-theme', next);
      return next;
    });
  };

  const saveConfig = async (newConfig: Config) => {
    try {
      const updated = await apiSaveConfig(newConfig);
      setConfig(updated);
      configRef.current = updated;
    } catch (err) {
      console.error(err);
    }
  };

  // Load full read-state from server once the workspace is ready (and when user changes)
  useEffect(() => {
    if (!workspaceConfigured) return;
    readCommentsLoadedRef.current = false;
    setReadComments({});
    fetchReadState()
      .then(state => {
        const userState = state[currentUser] ?? {};
        setReadComments(userState);
        readCommentsLoadedRef.current = true;
      })
      .catch(() => { readCommentsLoadedRef.current = true; });
  }, [currentUser, workspaceConfigured]);

  const ensureReadStateLoaded = useCallback((_ticketId: string) => {
    // no-op: full state is loaded on mount; kept for API compatibility
  }, []);

  const flushReadState = useCallback(() => {
    const patch = pendingReadStateRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingReadStateRef.current = {};
    saveReadState({ [currentUser]: patch }).catch((err) => {
      console.warn('[read-state] persist failed, retrying once', err);
      saveReadState({ [currentUser]: patch }).catch(() => {});
    });
  }, [currentUser]);

  const scheduleReadStateFlush = useCallback(() => {
    if (readStateFlushTimerRef.current !== null) return;
    readStateFlushTimerRef.current = window.setTimeout(() => {
      readStateFlushTimerRef.current = null;
      flushReadState();
    }, 50);
  }, [flushReadState]);

  const markCommentRead = useCallback((ticketId: string, commentId: string) => {
    setReadComments(prev => {
      const existing = prev[ticketId] ?? [];
      if (existing.includes(commentId)) return prev;
      const next = [...existing, commentId];
      const pending = pendingReadStateRef.current;
      pending[ticketId] = next;
      scheduleReadStateFlush();
      return { ...prev, [ticketId]: next };
    });
  }, [scheduleReadStateFlush]);

  const markAllCommentsRead = useCallback((ticketId: string, commentIds: string[]) => {
    setReadComments(prev => {
      const existing = new Set(prev[ticketId] ?? []);
      commentIds.forEach(id => existing.add(id));
      const next = [...existing];
      const pending = pendingReadStateRef.current;
      pending[ticketId] = next;
      scheduleReadStateFlush();
      return { ...prev, [ticketId]: next };
    });
  }, [scheduleReadStateFlush]);

  useEffect(() => {
    return () => {
      Object.values(taskEventTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      Object.values(columnEventTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      if (readStateFlushTimerRef.current !== null) {
        window.clearTimeout(readStateFlushTimerRef.current);
        flushReadState();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: number | undefined;

    const loadConfig = async () => {
      try {
        const loadedConfig = await fetchConfig();
        if (cancelled) return;
        setConfig(loadedConfig);
        configRef.current = loadedConfig;
        setCurrentProject((prev) => reconcileProject(prev, loadedConfig.projects));
      } catch (error) {
        console.error(error);
        if (cancelled) return;
        retryTimeout = window.setTimeout(() => {
          void loadConfig();
        }, 3000);
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
      if (retryTimeout) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadParseErrors();
  }, [loadTasks, loadParseErrors]);

  const refreshWorkspaces = useCallback(() => {
    fetchWorkspaces().then(setWorkspaces).catch(() => {});
  }, []);

  const notifyWorkspaceSet = useCallback(() => {
    fetchWorkspace()
      .then(({ configured, path: wp }) => {
        setWorkspaceConfigured(configured);
        setWorkspacePath(wp);
        if (configured) {
          void loadTasks();
          fetchConfig().then((c) => {
            setConfig(c);
            configRef.current = c;
            setCurrentProject((prev) => reconcileProject(prev, c.projects));
          }).catch(() => {});
          refreshWorkspaces();
          refreshNotifications();
        }
      })
      .catch(() => {});
  }, [loadTasks, refreshWorkspaces, refreshNotifications]);

  const switchWorkspace = useCallback(async (wsPath: string, force?: boolean) => {
    const result = await apiSwitchWorkspace(wsPath, force);
    if ('blocked' in result && result.blocked) {
      const proceed = window.confirm(`${result.message}\n\nStop them and switch anyway?`);
      if (proceed) {
        await switchWorkspace(wsPath, true);
      }
      return;
    }
    notifyWorkspaceSet();
  }, [notifyWorkspaceSet]);

  // On mount, fetch workspace state. Then poll health alongside connection checks.
  useEffect(() => {
    fetchWorkspace()
      .then(({ configured, path: wp }) => {
        setWorkspaceConfigured(configured);
        setWorkspacePath(wp);
      })
      .catch(() => {});
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    let checkTimeout: number;
    let cancelled = false;

    const checkHealth = async () => {
      try {
        const health = await fetchHealth();
        if (!cancelled) {
          setIsConnected(true);
          // Keep workspace state in sync if the server restarted with a workspace.
          const configured = health.workspace !== null && health.workspace !== undefined;
          setWorkspaceConfigured(configured);
          setWorkspacePath(health.workspace ?? null);
        }
      } catch (err) {
        if (!cancelled) setIsConnected(false);
      }
      
      if (!cancelled) {
        checkTimeout = window.setTimeout(checkHealth, 10000);
      }
    };

    void checkHealth();

    return () => {
      cancelled = true;
      if (checkTimeout) window.clearTimeout(checkTimeout);
    };
  }, []);

  useEffect(() => {
    if (isConnected) {
      void loadTasks();
      void loadParseErrors();
    }
  }, [isConnected, loadTasks, loadParseErrors]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (!document.hidden) {
        void loadTasks();
        void loadParseErrors();
      }
    };

    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setIsWindowVisible(visible);
      if (visible) {
        void loadTasks();
        void loadParseErrors();
      }
    };

    const handleFocus = () => {
      setIsWindowVisible(!document.hidden);
      refreshIfVisible();
    };

    const intervalId = window.setInterval(refreshIfVisible, LIVE_TASK_POLL_INTERVAL_MS);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadTasks, loadParseErrors]);

  // SSE: receive instant activity pushes from the engine instead of polling for them.
  useEffect(() => {
    if (!isConnected) return;
    const es = new EventSource('/api/events');
    es.addEventListener('activity', (e: MessageEvent) => {
      const { taskId, activity } = JSON.parse(e.data) as { taskId: string; activity: string | null };
      startTransition(() => {
        setTasks(prev => prev.map(t =>
          t.id === taskId
            ? { ...t, cliSession: t.cliSession ? { ...t.cliSession, currentActivity: activity ?? undefined } : t.cliSession }
            : t
        ));
      });
    });
    es.addEventListener('progress', (e: MessageEvent) => {
      const { taskId, sessionId, timestamp, message } = JSON.parse(e.data) as { taskId: string; sessionId: string; timestamp: string; message: string };
      startTransition(() => {
        setTasks(prev => prev.map(t => {
          if (t.id !== taskId || !t.history) return t;
          const updatedHistory = t.history.map(entry => {
            if (entry.type === 'agent_session' && entry.sessionId === sessionId && entry.status === 'active') {
              return {
                ...entry,
                progress: [...(entry.progress ?? []), { timestamp, message }]
              };
            }
            return entry;
          });
          return { ...t, history: updatedHistory };
        }));
      });
    });
    es.addEventListener('notification', (e: MessageEvent) => {
      const { notification, unreadCount } = JSON.parse(e.data) as { notification: Notification | null; unreadCount: number };
      startTransition(() => {
        if (notification) {
          setNotifications(prev => {
            const idx = prev.findIndex(n => n.id === notification.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = notification;
              return next;
            }
            return [notification, ...prev].slice(0, 50);
          });
        } else {
          setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        }
        setNotificationUnreadCount(unreadCount);
      });
    });
    es.addEventListener('restart_pending', () => {
      setRestartPending(true);
    });
    es.addEventListener('auto_restarting', () => {
      setRestartPending(false);
    });
    es.onerror = () => {
      // When SSE reconnects after an engine restart, clear the pending state
      if (es.readyState === EventSource.CONNECTING) {
        setRestartPending(false);
      }
    };
    refreshNotifications();
    return () => es.close();
  }, [isConnected, refreshNotifications]);

  useEffect(() => {
    updateViewUrl(getViewFromLocation(), 'replace');

    const handlePopState = () => {
      setCurrentView(getViewFromLocation());
      const nextFilters = getTaskFiltersFromLocation();
      setSearchQuery(nextFilters.searchQuery);
      setSortOption(nextFilters.sortOption);
      setFilterAssignee(nextFilters.filterAssignee);
      setFilterPriority(nextFilters.filterPriority);
      setFilterTag(nextFilters.filterTag);
      setFilterWorktree(nextFilters.filterWorktree);
    };

    const handleCustomNavigation = () => {
      handlePopState();
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('flux:navigate', handleCustomNavigation);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('flux:navigate', handleCustomNavigation);
    };
  }, []);

  useEffect(() => {
    updateTaskFilterUrl({ searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly, filterWorktree });
  }, [searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly, filterWorktree]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (!ticketId || tasksLoading) return;
    if (isModalOpen && modalTask?.id === ticketId) return;

    const task = tasks.find((item) => item.id === ticketId);
    if (!task) return;
    const view = params.get('view');
    if (view === 'full') {
      openTaskFullView(task);
    } else {
      setModalTask(task);
      setIsModalOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, modalTask?.id, tasks, tasksLoading]);

  // Keep the open modal's task data in sync with background poll updates.
  // Only update when something actually changed to avoid spurious re-renders.
  useEffect(() => {
    if (!isModalOpen || !modalTask?.id) return;
    const fresh = tasks.find((t) => t.id === modalTask.id);
    if (!fresh) return;
    const changed =
      fresh.status !== modalTask.status ||
      fresh.title !== modalTask.title ||
      fresh.body !== modalTask.body ||
      fresh.assignee !== modalTask.assignee ||
      fresh.priority !== modalTask.priority ||
      fresh.effort !== modalTask.effort ||
      fresh.implementationLink !== modalTask.implementationLink ||
      fresh.tags?.length !== modalTask.tags?.length ||
      fresh.subtasks?.length !== modalTask.subtasks?.length ||
      fresh.history?.length !== modalTask.history?.length;
    if (changed) setModalTask(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const totalUnreadCount = useMemo(() => {
    const archiveStatus = getArchiveStatus(config);
    const hiddenStatusNames = new Set(config?.hiddenStatuses?.map(s => s.name) ?? []);
    return tasks.reduce((sum, task) => {
      if (task.status === 'Released' || task.status === archiveStatus || hiddenStatusNames.has(task.status)) {
        return sum;
      }
      const readIds = new Set(readComments[task.id] ?? []);
      const hasUnread = (task.history ?? []).some(
        e => e.type === 'comment' && e.id && e.user !== currentUser && !readIds.has(e.id)
      );
      return sum + (hasUnread ? 1 : 0);
    }, 0);
  }, [tasks, readComments, currentUser, config]);

  return (
    <AppContext.Provider value={{
      currentUser, setCurrentUser,
      currentProject, setCurrentProject,
      searchQuery, setSearchQuery,
      sortOption, setSortOption,
      filterAssignee, setFilterAssignee,
      filterPriority, setFilterPriority,
      filterTag, setFilterTag,
      filterUnreadOnly, setFilterUnreadOnly,
      filterWorktree, setFilterWorktree,
      clearTaskFilters,
      view, setView,
      settingsTab, setSettingsTab,
      modalTask, isModalOpen,
      isOverlayOpen: overlayCount > 0,
      pushOverlay,
      popOverlay,
      openTaskModal,
      openTaskFullView,
      openModalScrollToComments,
      clearOpenModalScrollToComments,
      openModalInFullView,
      closeModal,
      setModalTask,
      tasks,
      taskById,
      worktreeBranches,
      worktrees,
      refreshWorktrees,
      changesFocus,
      setChangesFocus,
      tasksLoading,
      taskLiveEvents,
      columnLiveEvents,
      refreshTrigger, triggerRefresh,
      lastRefreshAt,
      isWindowVisible,
      isConnected,
      workspaceConfigured, workspacePath, notifyWorkspaceSet, workspaces, switchWorkspace, refreshWorkspaces,
      config, saveConfig,
      readComments, totalUnreadCount, ensureReadStateLoaded, markCommentRead, markAllCommentsRead,
      theme, setAppTheme, toggleTheme,
      parseErrors, parseErrorsLoading,
      notifications, notificationUnreadCount, refreshNotifications,
      restartPending,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
