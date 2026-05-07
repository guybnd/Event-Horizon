import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Task, Config } from './types';
import { fetchConfig, fetchTasks, saveConfig as apiSaveConfig } from './api';

type AppView = 'board' | 'backlog' | 'docs' | 'settings';
export type TaskSortOption = 'default' | 'priority' | 'updated' | 'assignee';

const VIEW_PATHS: Record<AppView, string> = {
  board: '/board',
  backlog: '/backlog',
  docs: '/docs',
  settings: '/settings',
};

function getViewFromLocation(): AppView {
  const path = window.location.pathname.toLowerCase();
  if (path === '/backlog') return 'backlog';
  if (path === '/docs') return 'docs';
  if (path === '/settings') return 'settings';
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
  refreshTrigger: number;
  triggerRefresh: () => void;
  config: Config | null;
  saveConfig: (updates: Config) => Promise<void>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const initialFilters = getTaskFiltersFromLocation();
  const [currentUser, setCurrentUser] = useState('Guy');
  const [currentProject, setCurrentProject] = useState('FLUX');
  const [searchQuery, setSearchQuery] = useState(initialFilters.searchQuery);
  const [sortOption, setSortOption] = useState<TaskSortOption>(initialFilters.sortOption);
  const [filterAssignee, setFilterAssignee] = useState(initialFilters.filterAssignee);
  const [filterPriority, setFilterPriority] = useState(initialFilters.filterPriority);
  const [filterTag, setFilterTag] = useState(initialFilters.filterTag);
  const [view, setCurrentView] = useState<AppView>(() => getViewFromLocation());
  const [modalTask, setModalTask] = useState<Partial<Task> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [config, setConfig] = useState<Config | null>(null);

  const triggerRefresh = () => setRefreshTrigger(prev => prev + 1);

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

  const updateTicketViewUrl = (taskId: string, viewMode: 'popup' | 'full') => {
    const url = new URL(window.location.href);
    url.searchParams.set('ticket', taskId);
    url.searchParams.set('view', viewMode);
    window.history.replaceState({}, '', url);
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
    setTimeout(() => setModalTask(null), 200);
  };

  const saveConfig = async (newConfig: Config) => {
    try {
      const updated = await apiSaveConfig(newConfig);
      setConfig(updated);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: number | undefined;

    const loadConfig = async () => {
      try {
        const loadedConfig = await fetchConfig();
        if (cancelled) return;
        setConfig(loadedConfig);
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

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    updateTaskFilterUrl({ searchQuery, sortOption, filterAssignee, filterPriority, filterTag });
  }, [searchQuery, sortOption, filterAssignee, filterPriority, filterTag]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (!ticketId) return;

    fetchTasks()
      .then((tasks) => {
        const task = tasks.find((item) => item.id === ticketId);
        if (!task) return;
        setModalTask(task);
        setIsModalOpen(true);
      })
      .catch(console.error);
  }, []);

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
      refreshTrigger, triggerRefresh,
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
