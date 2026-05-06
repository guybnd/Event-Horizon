import { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import type { Task, Config } from './types';
import { fetchConfig, saveConfig as apiSaveConfig } from './api';

interface AppState {
  currentUser: string;
  setCurrentUser: (user: string) => void;
  currentProject: string;
  setCurrentProject: (proj: string) => void;
  view: 'board' | 'backlog' | 'settings';
  setView: (view: 'board' | 'backlog' | 'settings') => void;
  modalTask: Partial<Task> | null;
  setModalTask: (task: Partial<Task> | null) => void;
  isModalOpen: boolean;
  closeModal: () => void;
  openTaskModal: (task?: Partial<Task>) => void;
  refreshTrigger: number;
  triggerRefresh: () => void;
  config: Config | null;
  saveConfig: (updates: Partial<Config>) => Promise<void>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState('Guy');
  const [currentProject, setCurrentProject] = useState('FLUX');
  const [view, setView] = useState<'board' | 'backlog' | 'settings'>('board');
  const [modalTask, setModalTask] = useState<Partial<Task> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [config, setConfig] = useState<Config | null>(null);

  const triggerRefresh = () => setRefreshTrigger(prev => prev + 1);

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
