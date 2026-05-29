import { useState, useCallback } from 'react';
import { AppProvider, useApp } from './AppContext';
import { Header } from './components/Header';
import { Board } from './components/Board';
import { BacklogScreen } from './components/BacklogScreen';
import { DocsScreen } from './components/DocsScreen';
import { TaskModal } from './components/TaskModal';
import { Settings } from './components/Settings';
import { ReleasesScreen } from './components/ReleasesScreen';
import { WorkflowBuilder } from './components/WorkflowBuilder';
import { WorkspaceSelector } from './components/WorkspaceSelector';
import { OnboardingWizard } from './components/OnboardingWizard';
import { FirstBootDialog } from './components/FirstBootDialog';

function AppContent() {
  const { view, workspaceConfigured, isConnected } = useApp();
  const [bootComplete, setBootComplete] = useState(false);

  const handleBootComplete = useCallback(() => setBootComplete(true), []);

  if (isConnected && !bootComplete) {
    return <FirstBootDialog onComplete={handleBootComplete} />;
  }

  const showOnboarding = isConnected && !localStorage.getItem('eh-onboarding-complete');
  if (showOnboarding) return <OnboardingWizard />;

  if (!workspaceConfigured && isConnected) {
    return <WorkspaceSelector />;
  }

  return (
    <div className="min-h-[100vh] h-screen flex flex-col font-sans app-shell" style={{ background: 'var(--eh-base)', color: 'var(--eh-text-primary)' }}>
      <Header />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto p-8">
          {view === 'board' && <Board />}
          {view === 'backlog' && <BacklogScreen />}
          {view === 'docs' && <DocsScreen />}
          {view === 'settings' && <Settings />}
          {view === 'releases' && <ReleasesScreen />}
          {view === 'workflows' && <WorkflowBuilder />}
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
