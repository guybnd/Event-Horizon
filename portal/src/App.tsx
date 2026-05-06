import { Board } from './components/Board';
import { Rocket } from 'lucide-react';

function App() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-bg-dark text-gray-900 dark:text-gray-100 flex flex-col font-sans">
      <header className="px-8 py-5 border-b border-gray-200 dark:border-white/5 bg-white/50 dark:bg-black/20 backdrop-blur-md flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 p-2 rounded-lg">
            <Rocket className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Event Horizon</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Local-first Agent Integration</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4 text-sm font-medium">
          <button className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors shadow-sm shadow-primary/20">
            New Task
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden p-8">
        <Board />
      </main>
    </div>
  );
}

export default App;
