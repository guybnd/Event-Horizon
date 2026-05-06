import { AppProvider, useApp } from './AppContext';
import { Header } from './components/Header';
import { Board } from './components/Board';
import { BacklogScreen } from './components/BacklogScreen';
import { TaskModal } from './components/TaskModal';
import { Settings } from './components/Settings';

function AppContent() {
  const { view } = useApp();

  return (
    <div className="min-h-[100vh] h-screen bg-gray-50 dark:bg-bg-dark text-gray-900 dark:text-gray-100 flex flex-col font-sans">
      <Header />
      <main className="flex-1 overflow-y-auto p-8">
        {view === 'board' && <Board />}
        {view === 'backlog' && <BacklogScreen />}
        {view === 'settings' && <Settings />}
      </main>
      <TaskModal />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
