import { AppProvider, useApp } from './AppContext';
import { Header } from './components/Header';
import { Board } from './components/Board';
import { BacklogScreen } from './components/BacklogScreen';
import { DocsScreen } from './components/DocsScreen';
import { TaskModal } from './components/TaskModal';
import { Settings } from './components/Settings';
import { ReleasesScreen } from './components/ReleasesScreen';
import { WorkspaceSelector } from './components/WorkspaceSelector';

function AppContent() {
  const { view, workspaceConfigured, isConnected } = useApp();

  // Show workspace picker until the engine has a project folder configured.
  // If the engine is offline, skip the picker to show the normal UI with the disconnect banner.
  if (!workspaceConfigured && isConnected) {
    return <WorkspaceSelector />;
  }

  return (
    <div className="min-h-[100vh] h-screen bg-gray-50 dark:bg-bg-dark text-gray-900 dark:text-gray-100 flex flex-col font-sans">
      <Header />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto p-8">
          {view === 'board' && <Board />}
          {view === 'backlog' && <BacklogScreen />}
          {view === 'docs' && <DocsScreen />}
          {view === 'settings' && <Settings />}
          {view === 'releases' && <ReleasesScreen />}
        </main>
        <TaskModal />
      </div>
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
