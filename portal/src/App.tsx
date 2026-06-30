import { useState, useCallback, lazy, Suspense } from 'react';
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
import { PendingInteractionsProvider } from './components/pendingInteractions';
import { Settings } from './components/Settings';
import { ReleasesScreen } from './components/ReleasesScreen';
import { EpicsScreen } from './components/EpicsScreen';
import { WorkflowBuilder } from './components/WorkflowBuilder';
import { WorkspaceSelector } from './components/WorkspaceSelector';
import { OnboardingWizard } from './components/OnboardingWizard';
import { FirstBootDialog } from './components/FirstBootDialog';

// Dev-only Onboarding Studio (FLUX-759, extends the FLUX-755 editor). The lazy()
// — and thus the dynamic import() — lives inside an `import.meta.env.DEV` branch
// that is statically `false` in a production build, so the bundler dead-code-
// eliminates the import and never emits the Studio chunk into prod dist at all
// (not even as an unreachable async chunk).
const OnboardingStudioScreen = import.meta.env.DEV
  ? lazy(() => import('./components/dev/OnboardingStudioScreen').then((m) => ({ default: m.OnboardingStudioScreen })))
  : null;

function AppContent() {
  const view = useAppSelector(s => s.view);
  const workspaceConfigured = useAppSelector(s => s.workspaceConfigured);
  const isConnected = useAppSelector(s => s.isConnected);
  const onboardingComplete = useAppSelector(s => s.onboardingComplete);
  const [bootComplete, setBootComplete] = useState(false);

  const handleBootComplete = useCallback(() => setBootComplete(true), []);

  if (isConnected && !bootComplete) {
    return <FirstBootDialog onComplete={handleBootComplete} />;
  }

  // FLUX-755: let the dev-only /dev/onboarding editor bypass the onboarding gate.
  // A dev iterating on the wizard typically CLEARS `eh-onboarding-complete` to re-test
  // it — for them this early return would otherwise win before the Header (dev nav link)
  // or the `view === 'dev-onboarding'` branch ever render, making the editor unreachable
  // even by hand-typing /dev/onboarding. The exception is import.meta.env.DEV-gated and
  // statically false in a prod build, so it cannot widen the onboarding gate when shipped.
  const showOnboarding = isConnected && !onboardingComplete;
  if (showOnboarding && !(import.meta.env.DEV && view === 'dev-onboarding')) return <OnboardingWizard />;

  // The dev editor reads a repo-relative config file (not the workspace), so it must
  // also clear the workspace gate — otherwise a dev with no workspace configured would
  // get the selector instead of the editor. import.meta.env.DEV-gated (prod no-op).
  if (!workspaceConfigured && isConnected && !(import.meta.env.DEV && view === 'dev-onboarding')) {
    return <WorkspaceSelector />;
  }

  return (
    <div className="min-h-dvh h-screen flex flex-col font-sans app-shell" style={{ background: 'var(--eh-base)', color: 'var(--eh-text-primary)' }}>
      <Header />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto px-8 pt-2.5 pb-5">
          {view === 'board' && <Board />}
          {view === 'backlog' && <BacklogScreen />}
          {view === 'changes' && <ChangesScreen />}
          {view === 'docs' && <DocsScreen />}
          {view === 'settings' && <Settings />}
          {view === 'releases' && <ReleasesScreen />}
          {view === 'epics' && <EpicsScreen />}
          {view === 'workflows' && <WorkflowBuilder />}
          {import.meta.env.DEV && view === 'dev-onboarding' && OnboardingStudioScreen && (
            <Suspense fallback={null}>
              <OnboardingStudioScreen />
            </Suspense>
          )}
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
        <PendingInteractionsProvider>
          <AppContent />
        </PendingInteractionsProvider>
      </DockProvider>
    </AppProvider>
  );
}

export default App;
