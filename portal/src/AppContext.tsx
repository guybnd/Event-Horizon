import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Task, Config } from './types';
import { fetchConfig, fetchTasks, saveConfig as apiSaveConfig } from './api';

type AppView = 'board' | 'backlog' | 'settings';

const VIEW_PATHS: Record<AppView, string> = {
  board: '/board',
  backlog: '/backlog',
  settings: '/settings',
};

function getViewFromLocation(): AppView {
  const path = window.location.pathname.toLowerCase();
  if (path === '/backlog') return 'backlog';
  if (path === '/settings') return 'settings';
  return 'board';
}

function updateViewUrl(view: AppView, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  url.pathname = VIEW_PATHS[view];
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
}

interface AppState {
  currentUser: string;
  setCurrentUser: (user: string) => void;
  currentProject: string;
  setCurrentProject: (proj: string) => void;
  view: AppView;
  setView: (view: AppView) => void;
  modalTask: Partial<Task> | null;
  setModalTask: (task: Partial<Task> | null) => void;
  isModalOpen: boolean;
  closeModal: () => void;
  openTaskModal: (task?: Partial<Task>) => void;
  refreshTrigger: number;
  triggerRefresh: () => void;
  config: Config | null;
  saveConfig: (updates: Config) => Promise<void>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState('Guy');
  const [currentProject, setCurrentProject] = useState('FLUX');
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

  const openTaskModal = (task?: Partial<Task>) => {
    setModalTask(task || { status: 'Todo' });
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
    fetchConfig().then(setConfig).catch(console.error);
  }, []);

  useEffect(() => {
    updateViewUrl(getViewFromLocation(), 'replace');

    const handlePopState = () => {
      setCurrentView(getViewFromLocation());
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

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
      view, setView,
      modalTask, isModalOpen,
      openTaskModal,
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
