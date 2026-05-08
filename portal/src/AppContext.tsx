import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ColumnLiveEvent, Config, Task, TaskLiveEvent } from './types';
import { fetchConfig, fetchTasks, fetchHealth, saveConfig as apiSaveConfig } from './api';

type AppView = 'board' | 'backlog' | 'docs' | 'settings' | 'releases';
export type TaskSortOption = 'default' | 'priority' | 'updated' | 'assignee';

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
    ...task,
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
  };
}

function updateTaskFilterUrl(filters: {
  searchQuery: string;
  sortOption: TaskSortOption;
  filterAssignee: string;
  filterPriority: string;
  filterTag: string;
}) {
  const url = new URL(window.location.href);
  const entries: Array<[string, string, string]> = [
    ['search', filters.searchQuery, ''],
    ['sort', filters.sortOption, 'default'],
    ['assignee', filters.filterAssignee, 'all'],
    ['priority', filters.filterPriority, 'all'],
    ['tag', filters.filterTag, 'all'],
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
  clearTaskFilters: () => void;
  view: AppView;
  setView: (view: AppView) => void;
  modalTask: Partial<Task> | null;
  setModalTask: (task: Partial<Task> | null) => void;
  isModalOpen: boolean;
  closeModal: () => void;
  openTaskModal: (task?: Partial<Task>) => void;
  openTaskFullView: (task: Partial<Task>) => void;
  tasks: Task[];
  tasksLoading: boolean;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  columnLiveEvents: Record<string, ColumnLiveEvent>;
  refreshTrigger: number;
  triggerRefresh: () => void;
  lastRefreshAt: number | null;
  isWindowVisible: boolean;
  isConnected: boolean;
  config: Config | null;
  saveConfig: (updates: Config) => Promise<void>;
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
  const [view, setCurrentView] = useState<AppView>(() => getViewFromLocation());
  const [modalTask, setModalTask] = useState<Partial<Task> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskLiveEvents, setTaskLiveEvents] = useState<Record<string, TaskLiveEvent>>({});
  const [columnLiveEvents, setColumnLiveEvents] = useState<Record<string, ColumnLiveEvent>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [isWindowVisible, setIsWindowVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));
  const [isConnected, setIsConnected] = useState(true);
  const [config, setConfig] = useState<Config | null>(null);
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
      setTasksLoading(false);

      if (!changed && previousTasks.length > 0) {
        return;
      }

      tasksRef.current = fetchedTasks;
      setTasks(fetchedTasks);
      setLastRefreshAt(Date.now());

      if (shouldEmitLiveEvents) {
        applyLiveEvents(nextTaskEvents, nextColumnEvents);
      }
    } catch (error) {
      console.error(error);

      if (!hasLoadedTasksRef.current) {
        setTasksLoading(true);
      }
    } finally {
      isFetchingTasksRef.current = false;
    }
  }, [applyLiveEvents]);

  const triggerRefresh = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
    void loadTasks();
  }, [loadTasks]);

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
  };

  const openTaskModal = (task?: Partial<Task>) => {
    const nextTask = task || { status: 'Todo' };
    if (nextTask.id) {
      updateTicketViewUrl(nextTask.id, 'popup');
    }
    setModalTask(nextTask);
    setIsModalOpen(true);
  };

  const openTaskFullView = (task: Partial<Task>) => {
    if (task.id) {
      updateTicketViewUrl(task.id, 'full');
    }
    setModalTask(task);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setTimeout(() => setModalTask(null), 1000);
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
  }, [loadTasks]);

  useEffect(() => {
    let checkTimeout: number;
    let cancelled = false;

    const checkHealth = async () => {
      try {
        await fetchHealth();
        if (!cancelled) setIsConnected(true);
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
    }
  }, [isConnected, loadTasks]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.hidden) {
        return;
      }

      void loadTasks();
    };

    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setIsWindowVisible(visible);

      if (visible) {
        refreshIfVisible();
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
  }, [loadTasks]);

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
    updateTaskFilterUrl({ searchQuery, sortOption, filterAssignee, filterPriority, filterTag });
  }, [searchQuery, sortOption, filterAssignee, filterPriority, filterTag]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (!ticketId || tasksLoading) return;
    if (isModalOpen && modalTask?.id === ticketId) return;

    const task = tasks.find((item) => item.id === ticketId);
    if (!task) return;
    setModalTask(task);
    setIsModalOpen(true);
  }, [isModalOpen, modalTask?.id, tasks, tasksLoading]);

  return (
    <AppContext.Provider value={{
      currentUser, setCurrentUser,
      currentProject, setCurrentProject,
      searchQuery, setSearchQuery,
      sortOption, setSortOption,
      filterAssignee, setFilterAssignee,
      filterPriority, setFilterPriority,
      filterTag, setFilterTag,
      clearTaskFilters,
      view, setView,
      modalTask, isModalOpen,
      openTaskModal,
      openTaskFullView,
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
      config, saveConfig
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
