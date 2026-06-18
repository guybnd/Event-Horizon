import { useState, useCallback } from 'react';
import { AppProvider } from './AppContext';
import { useAppSelector } from './store/useAppSelector';
import { Header } from './components/Header';
import { Board } from './components/Board';
import { BacklogScreen } from './components/BacklogScreen';
import { ChangesScreen } from './components/changes/ChangesScreen';
import { DocsScreen } from './components/DocsScreen';
import { TaskModal } from './components/TaskModal';
import { ChatDock } from './components/ChatDock';
import { DockProvider } from './components/DockProvider';
import { Settings } from './components/Settings';
import { ReleasesScreen } from './components/ReleasesScreen';
import { WorkflowBuilder } from './components/WorkflowBuilder';
import { WorkspaceSelector } from './components/WorkspaceSelector';
import { OnboardingWizard } from './components/OnboardingWizard';
import { FirstBootDialog } from './components/FirstBootDialog';
import { RestartBanner } from './components/RestartBanner';

function AppContent() {
  const view = useAppSelector(s => s.view);
  const workspaceConfigured = useAppSelector(s => s.workspaceConfigured);
  const isConnected = useAppSelector(s => s.isConnected);
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
    <div className="min-h-dvh h-screen flex flex-col font-sans app-shell" style={{ background: 'var(--eh-base)', color: 'var(--eh-text-primary)' }}>
      <RestartBanner />
      <Header />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto px-8 pt-2.5 pb-5">
          {view === 'board' && <Board />}
          {view === 'backlog' && <BacklogScreen />}
          {view === 'changes' && <ChangesScreen />}
          {view === 'docs' && <DocsScreen />}
          {view === 'settings' && <Settings />}
          {view === 'releases' && <ReleasesScreen />}
          {view === 'workflows' && <WorkflowBuilder />}
        </main>
        <TaskModal />
        <ChatDock />
      </div>
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <DockProvider>
        <AppContent />
      </DockProvider>
    </AppProvider>
  );
}

export default App;
