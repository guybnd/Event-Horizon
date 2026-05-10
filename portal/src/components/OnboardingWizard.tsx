import { useState } from 'react';
import {
  FolderOpen,
  Rocket,
  Terminal,
  BookOpen,
  PartyPopper,
  CheckCircle,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { pickWorkspaceFolder, setWorkspace, installWorkspaceSkill } from '../api';
import { useApp } from '../AppContext';

const COMPLETE_KEY = 'eh-onboarding-complete';
const SKIP_INSTALL_KEY = 'onboarding-install-skipped';

const FRAMEWORKS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'cline', label: 'Cline' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'generic', label: 'Generic / Other' },
];

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`block rounded-full transition-all ${
            i + 1 === current
              ? 'w-6 h-2 bg-primary'
              : i + 1 < current
              ? 'w-2 h-2 bg-primary/40'
              : 'w-2 h-2 bg-gray-200 dark:bg-white/15'
          }`}
        />
      ))}
    </div>
  );
}

export function OnboardingWizard() {
  const { notifyWorkspaceSet, setView } = useApp();
  const [step, setStep] = useState(1);
  const [folderPath, setFolderPath] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selectedFramework, setSelectedFramework] = useState('claude');
  const [installing, setInstalling] = useState(false);
  const [installDone, setInstallDone] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  function complete() {
    localStorage.setItem(COMPLETE_KEY, '1');
    notifyWorkspaceSet();
  }

  function skip() {
    localStorage.setItem(COMPLETE_KEY, '1');
    // notifyWorkspaceSet will re-evaluate workspaceConfigured — if no folder was
    // picked yet the WorkspaceSelector will take over from App.tsx.
    notifyWorkspaceSet();
  }

  // Step 1 — folder
  async function handleBrowse() {
    setPicking(true);
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) setFolderPath(picked);
    } finally {
      setPicking(false);
    }
  }

  async function handleOpenFolder(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setFolderError(null);
    setFolderLoading(true);
    try {
      await setWorkspace(trimmed);
      setStep(2);
    } catch (err: any) {
      setFolderError(err.message || 'Failed to open workspace.');
    } finally {
      setFolderLoading(false);
    }
  }

  // Step 3 — install
  async function handleInstall() {
    setInstalling(true);
    setInstallError(null);
    try {
      await installWorkspaceSkill(selectedFramework);
      setInstallDone(true);
    } catch (err: any) {
      setInstallError(err.message || 'Installation failed.');
    } finally {
      setInstalling(false);
    }
  }

  function handleSkipInstall() {
    localStorage.setItem(SKIP_INSTALL_KEY, 'true');
    setStep(4);
  }

  // Step 4 — docs
  function handleGoDocs() {
    complete();
    setView('docs');
  }

  // Step 5 — finish
  function handleFirstTicket() {
    complete();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-bg-dark p-8">
      <div className="w-full max-w-lg">
        <StepDots current={step} total={5} />

        {step === 1 && (
          <div>
            <div className="mb-8 flex flex-col items-center gap-3 text-center">
              <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
                <FolderOpen className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Welcome to Event Horizon
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
                Let's get you set up. First, pick the project folder you want to
                track. The wizard will create a{' '}
                <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
                  .flux/
                </code>{' '}
                directory automatically if it doesn't exist. You can also run{' '}
                <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
                  event-horizon init
                </code>{' '}
                manually as an alternative.
              </p>
            </div>

            <form onSubmit={handleOpenFolder} className="flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/5">
                <FolderOpen className="h-5 w-5 shrink-0 text-gray-400" />
                <input
                  autoFocus
                  type="text"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  placeholder={
                    navigator.platform.toLowerCase().includes('win')
                      ? 'C:\\Users\\you\\my-project'
                      : '/home/you/my-project'
                  }
                  className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
                />
                <button
                  type="button"
                  onClick={handleBrowse}
                  disabled={picking}
                  className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  {picking ? '…' : 'Browse'}
                </button>
              </div>

              {folderError && (
                <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{folderError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={folderLoading || !folderPath.trim()}
                className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {folderLoading ? 'Opening…' : 'Open Project →'}
              </button>
            </form>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="mb-8 flex flex-col items-center gap-3 text-center">
              <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
                <Terminal className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Pick your AI assistant
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
                Event Horizon installs a workflow skill into your AI coding assistant so it can manage tickets automatically.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-6 sm:grid-cols-3">
              {FRAMEWORKS.map((fw) => (
                <button
                  key={fw.id}
                  onClick={() => setSelectedFramework(fw.id)}
                  className={`rounded-xl border px-4 py-3 text-sm font-medium transition-all text-left ${
                    selectedFramework === fw.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-primary/50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300'
                  }`}
                >
                  {fw.label}
                  {fw.id === 'claude' && (
                    <span className="ml-1 text-xs opacity-60">(default)</span>
                  )}
                </button>
              ))}
            </div>

            <button
              onClick={() => setStep(3)}
              className="flex h-11 w-full items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
            >
              Continue →
            </button>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="mb-8 flex flex-col items-center gap-3 text-center">
              <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
                <Rocket className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Install the integration
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
                This copies the Event Horizon workflow skill into your{' '}
                <strong>{FRAMEWORKS.find((f) => f.id === selectedFramework)?.label}</strong>{' '}
                workspace so the agent knows how to manage your tickets.
              </p>
            </div>

            {installDone ? (
              <div className="mb-6 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                <CheckCircle className="h-5 w-5 shrink-0" />
                <span>Integration installed successfully!</span>
              </div>
            ) : installError ? (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{installError}</span>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              {!installDone && (
                <button
                  onClick={handleInstall}
                  disabled={installing}
                  className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:opacity-50"
                >
                  {installing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Installing…
                    </>
                  ) : (
                    'Install now'
                  )}
                </button>
              )}
              {!installDone && (
                <button
                  onClick={handleSkipInstall}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  Skip for now
                </button>
              )}
              {installDone && (
                <button
                  onClick={() => setStep(4)}
                  className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
                >
                  Continue →
                </button>
              )}
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <div className="mb-8 flex flex-col items-center gap-3 text-center">
              <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
                <BookOpen className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Explore the docs
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
                Event Horizon ships with built-in documentation covering workflow setup, ticket management, and the agent integration. Worth a quick look before diving in.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={handleGoDocs}
                className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
              >
                Open the docs
              </button>
              <button
                onClick={() => setStep(5)}
                className="flex h-11 items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
              >
                I'll check later
              </button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div>
            <div className="mb-8 flex flex-col items-center gap-3 text-center">
              <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
                <PartyPopper className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                You're all set!
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
                Your workspace is ready. Create your first ticket, assign it to your AI assistant, and watch it take off.
              </p>
            </div>

            <button
              onClick={handleFirstTicket}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
            >
              <Rocket className="h-4 w-4" />
              Try your first ticket
            </button>
          </div>
        )}

        {/* Global skip link */}
        <div className="mt-6 text-center">
          <button
            onClick={skip}
            className="text-xs text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400 transition-colors"
          >
            Skip setup
          </button>
        </div>
      </div>
    </div>
  );
}
