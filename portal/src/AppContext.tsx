import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ColumnLiveEvent, Config, Task, TaskLiveEvent } from './types';
import { fetchConfig, fetchTasks, fetchHealth, saveConfig as apiSaveConfig, fetchReadState, saveReadState, fetchWorkspace, fetchParseErrors, fetchNotifications, type ParseError, type Notification } from './api';
import { getArchiveStatus } from './workflow';

export type AppView = 'board' | 'backlog' | 'docs' | 'settings' | 'releases';
export type TaskSortOption = 'default' | 'priority' | 'updated' | 'assignee';
export type AppTheme = 'light' | 'dark';

function getInitialTheme(): AppTheme {
  const stored = localStorage.getItem('eh-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: AppTheme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

const VIEW_PATHS: Record<AppView, string> = {
  board: '/board',
  backlog: '/backlog',
  docs: '/docs',
  settings: '/settings',
  releases: '/releases',
};

const LIVE_TASK_POLL_INTERVAL_MS = 3000;
const LIVE_EVENT_DURATION_MS = 2200;

function normalizeTaskList(tasks: Task[]) {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}

function buildTaskSignature(task: Task) {
  return JSON.stringify({
    id: task.id,
    status: task.status,
    title: task.title || '',
    body: task.body || '',
    assignee: task.assignee || 'unassigned',
    priority: task.priority || 'None',
    effort: task.effort || 'None',
    implementationLink: task.implementationLink || '',
    order: task.order ?? null,
    tags: task.tags || [],
    subtasks: task.subtasks || [],
    history: task.history || [],
    // cliSession fields that matter for UI — liveOutput is excluded (append-only, grows unboundedly)
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
  if (path === '/docs') return 'docs';
  if (path === '/settings') return 'settings';
  if (path === '/releases') return 'releases';
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
  };
}

function updateTaskFilterUrl(filters: {
  searchQuery: string;
  sortOption: TaskSortOption;
  filterAssignee: string;
  filterPriority: string;
  filterTag: string;
  filterUnreadOnly: boolean;
}) {
  const url = new URL(window.location.href);
  const entries: Array<[string, string, string]> = [
    ['search', filters.searchQuery, ''],
    ['sort', filters.sortOption, 'default'],
    ['assignee', filters.filterAssignee, 'all'],
    ['priority', filters.filterPriority, 'all'],
    ['tag', filters.filterTag, 'all'],
    ['unread', filters.filterUnreadOnly ? '1' : '', ''],
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
  clearTaskFilters: () => void;
  view: AppView;
  setView: (view: AppView) => void;
  modalTask: Partial<Task> | null;
  setModalTask: (task: Partial<Task> | null) => void;
  isModalOpen: boolean;
  closeModal: () => void;
  openTaskModal: (task?: Partial<Task>) => void;
  openTaskFullView: (task: Partial<Task>, options?: { scrollToComments?: boolean }) => void;
  openModalScrollToComments: boolean;
  clearOpenModalScrollToComments: () => void;
  openModalInFullView: boolean;
  tasks: Task[];
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
  config: Config | null;
  saveConfig: (updates: Config) => Promise<void>;
  readComments: Record<string, string[]>;
  totalUnreadCount: number;
  ensureReadStateLoaded: (ticketId: string) => void;
  markCommentRead: (ticketId: string, commentId: string) => void;
  markAllCommentsRead: (ticketId: string, commentIds: string[]) => void;
  theme: AppTheme;
  toggleTheme: () => void;
  parseErrors: ParseError[];
  parseErrorsLoading: boolean;
  notifications: Notification[];
  notificationUnreadCount: number;
  refreshNotifications: () => void;
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
  const [view, setCurrentView] = useState<AppView>(() => getViewFromLocation());
  const [modalTask, setModalTask] = useState<Partial<Task> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [openModalScrollToComments, setOpenModalScrollToComments] = useState(false);
  const [openModalInFullView, setOpenModalInFullView] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
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
  const readCommentsLoadedRef = useRef(false);
  const configRef = useRef<Config | null>(null);
  const tasksRef = useRef<Task[]>([]);
  const isFetchingTasksRef = useRef(false);
  const hasLoadedTasksRef = useRef(false);
  const taskEventTimeoutsRef = useRef<Record<string, number>>({});
  const columnEventTimeoutsRef = useRef<Record<string, number>>({});
  const liveEventSequenceRef = useRef(0);

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

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: AppTheme = prev === 'dark' ? 'light' : 'dark';
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

  const markCommentRead = useCallback((ticketId: string, commentId: string) => {
    setReadComments(prev => {
      const existing = prev[ticketId] ?? [];
      if (existing.includes(commentId)) return prev;
      const next = [...existing, commentId];
      void saveReadState({ [currentUser]: { [ticketId]: next } });
      return { ...prev, [ticketId]: next };
    });
  }, [currentUser]);

  const markAllCommentsRead = useCallback((ticketId: string, commentIds: string[]) => {
    setReadComments(prev => {
      const existing = new Set(prev[ticketId] ?? []);
      commentIds.forEach(id => existing.add(id));
      const next = [...existing];
      void saveReadState({ [currentUser]: { [ticketId]: next } });
      return { ...prev, [ticketId]: next };
    });
  }, [currentUser]);

  useEffect(() => {
    return () => {
      Object.values(taskEventTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      Object.values(columnEventTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
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
        setCurrentProject((prev) => prev || loadedConfig.projects?.[0] || 'PROJECT');
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

  // On mount, fetch workspace state. Then poll health alongside connection checks.
  useEffect(() => {
    fetchWorkspace()
      .then(({ configured, path: wp }) => {
        setWorkspaceConfigured(configured);
        setWorkspacePath(wp);
      })
      .catch(() => {});
  }, []);

  const notifyWorkspaceSet = useCallback(() => {
    fetchWorkspace()
      .then(({ configured, path: wp }) => {
        setWorkspaceConfigured(configured);
        setWorkspacePath(wp);
        if (configured) {
          void loadTasks();
          fetchConfig().then(setConfig).catch(() => {});
        }
      })
      .catch(() => {});
  }, [loadTasks]);

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
                progress: [...entry.progress, { timestamp, message }]
              };
            }
            return entry;
          });
          return { ...t, history: updatedHistory };
        }));
      });
    });
    es.addEventListener('notification', (e: MessageEvent) => {
      const { notification, unreadCount } = JSON.parse(e.data) as { notification: Notification; unreadCount: number };
      startTransition(() => {
        setNotifications(prev => {
          const idx = prev.findIndex(n => n.id === notification.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = notification;
            return next;
          }
          return [notification, ...prev].slice(0, 50);
        });
        setNotificationUnreadCount(unreadCount);
      });
    });
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
    updateTaskFilterUrl({ searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly });
  }, [searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly]);

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
      clearTaskFilters,
      view, setView,
      modalTask, isModalOpen,
      openTaskModal,
      openTaskFullView,
      openModalScrollToComments,
      clearOpenModalScrollToComments,
      openModalInFullView,
      closeModal,
      setModalTask,
      tasks,
      tasksLoading,
      taskLiveEvents,
      columnLiveEvents,
      refreshTrigger, triggerRefresh,
      lastRefreshAt,
      isWindowVisible,
      isConnected,
      workspaceConfigured, workspacePath, notifyWorkspaceSet,
      config, saveConfig,
      readComments, totalUnreadCount, ensureReadStateLoaded, markCommentRead, markAllCommentsRead,
      theme, toggleTheme,
      parseErrors, parseErrorsLoading,
      notifications, notificationUnreadCount, refreshNotifications,
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
