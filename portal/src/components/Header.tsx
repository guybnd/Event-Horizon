import { Rocket, ListTodo, KanbanSquare, Settings as SettingsIcon } from 'lucide-react';
import { useApp } from '../AppContext';

export function Header() {
  const { view, setView, currentUser, setCurrentUser, currentProject, setCurrentProject } = useApp();

  return (
    <header className="px-8 py-4 border-b border-gray-200 dark:border-white/5 bg-white/50 dark:bg-black/20 backdrop-blur-md flex items-center justify-between sticky top-0 z-10">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 p-2 rounded-lg">
            <Rocket className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight leading-none mb-1">Event Horizon</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Local-first Integration</p>
          </div>
        </div>

        <div className="h-8 w-px bg-gray-200 dark:bg-white/10 mx-2"></div>

        <div className="flex items-center gap-2 bg-gray-100 dark:bg-black/40 p-1 rounded-lg">
          <button 
            onClick={() => setView('board')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'board' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <KanbanSquare className="w-4 h-4" /> Board
          </button>
          <button 
            onClick={() => setView('backlog')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'backlog' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <ListTodo className="w-4 h-4" /> Backlog
          </button>
          <button 
            onClick={() => setView('settings')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'settings' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <SettingsIcon className="w-4 h-4" /> Settings
          </button>
        </div>
      </div>
      
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-end">
          <label className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Project Key</label>
          <input 
            value={currentProject} 
            onChange={e => setCurrentProject(e.target.value.toUpperCase())}
            className="bg-transparent text-sm font-semibold outline-none text-right w-24 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
          />
        </div>
        <div className="flex flex-col items-end">
          <label className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Current User</label>
          <input 
            value={currentUser} 
            onChange={e => setCurrentUser(e.target.value)}
            className="bg-transparent text-sm font-semibold outline-none text-right w-32 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
          />
        </div>
      </div>
    </header>
  );
}
