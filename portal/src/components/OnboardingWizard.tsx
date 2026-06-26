import { useState, useEffect, useMemo, type ReactNode } from 'react';
import {
  FolderOpen,
  Rocket,
  Terminal,
  PartyPopper,
  CheckCircle,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  GitBranch,
  HardDrive,
  User,
  Package,
} from 'lucide-react';
import { pickWorkspaceFolder, setWorkspace, installWorkspaceSkill, fetchPathInfo, setupPath, migrateStorage, restoreStorage, fetchStorageMode, fetchConfig, saveConfig as apiSaveConfig } from '../api';
import { useAppActions } from '../store/useAppSelector';
import { BootstrapPreview } from './BootstrapPreview';
import { FEATURE_PANELS } from '../config/onboardingFeatures';
import { OnboardingContentPage } from './onboarding/OnboardingContentPage';
import { DirectoryPicker } from './onboarding/DirectoryPicker';
import {
  validateFlow,
  visiblePages,
  type ConditionContext,
  type OnboardingPage,
  type OnboardingWidgetId,
} from '../config/onboardingFlow';
import rawFlow from '../config/onboardingFlow.json';

const SKIP_INSTALL_KEY = 'onboarding-install-skipped';

/**
 * Normalize a raw OS platform string (pathInfo.platform or navigator.platform)
 * to one of the stable tokens 'win' | 'mac' | 'linux' a condition compares
 * against. Defaults to 'linux' for anything unrecognized.
 */
function normalizePlatform(raw: string | undefined): string {
  const p = (raw ?? '').toLowerCase();
  if (p.includes('win')) return 'win';
  if (p.includes('mac') || p.includes('darwin')) return 'mac';
  return 'linux';
}

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
  const { notifyWorkspaceSet, setView, markOnboardingComplete, setCurrentUser } = useAppActions();

  // Data-driven flow (FLUX-756 Phase 1). The wizard renders from the validated
  // flow config instead of a hardcoded step===N switch. validateFlow guarantees a
  // safe, dependency-correct ordering even from a hand-edited/corrupt file, and
  // falls back to DEFAULT_FLOW on a missing/garbage file.
  const flow = useMemo(() => validateFlow(rawFlow), []);

  const [folderPath, setFolderPath] = useState('');
  const [userName, setUserName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  // FLUX-758: in-app styled folder browser replaces the native OS dialog.
  const [browseOpen, setBrowseOpen] = useState(false);

  // Step 2 — sync mode
  const [selectedMode, setSelectedMode] = useState<'in-repo' | 'orphan'>('in-repo');
  // FLUX-758: the workspace's ACTUAL current mode, detected on entry to this step.
  // null = not yet fetched. Drives pre-selection + the "continue as-is" no-op path.
  const [currentMode, setCurrentMode] = useState<'in-repo' | 'orphan' | null>(null);
  const [modeLoading, setModeLoading] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [selectedFramework, setSelectedFramework] = useState('claude');
  const [installing, setInstalling] = useState(false);
  const [installDone, setInstallDone] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Step 4 — PATH setup
  const [pathInfo, setPathInfo] = useState<{ binaryDir: string | null; isPkg: boolean; platform: string } | null>(null);
  const [pathAction, setPathAction] = useState<'auto' | 'instructional' | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathDone, setPathDone] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathSnippet, setPathSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // -------------------------------------------------------------------------
  // VISIBLE PAGE SEQUENCE (FLUX-763 Phase 4). The wizard now evaluates
  // page.conditions and honors page.hidden when building the rendered sequence,
  // instead of walking flow.pages verbatim. The ConditionContext is derived
  // entirely from existing wizard state — nothing new is collected:
  //   storageMode        <- selectedMode
  //   assistant          <- selectedFramework
  //   platform           <- pathInfo?.platform ?? navigator.platform (normalized)
  //   workspaceConfigured<- folderPath is set
  // visiblePages() FORCE-KEEPS required system pages, so conditions/hidden can
  // never produce a setup missing folder/storage/assistant/completion.
  // -------------------------------------------------------------------------
  const ctx = useMemo<ConditionContext>(
    () => ({
      storageMode: selectedMode,
      assistant: selectedFramework,
      platform: normalizePlatform(pathInfo?.platform ?? navigator.platform),
      workspaceConfigured: folderPath.trim() !== '',
    }),
    [selectedMode, selectedFramework, pathInfo, folderPath],
  );

  const pages = useMemo(() => visiblePages(flow.pages, ctx), [flow, ctx]);

  // Walk by PAGE ID (not a raw index) so the position survives mid-flow
  // re-filtering: toggling storage mode can include/exclude a conditioned page
  // live, which would shift raw indices out from under the walker.
  const [currentId, setCurrentId] = useState<string>(() => pages[0]?.id ?? '');

  // Resolve the current visible index from currentId. If the current page just
  // dropped out of the visible list (a ctx change hid it), clamp to the last
  // visible page so we never land past the end / on a blank page.
  const rawIndex = pages.findIndex((p) => p.id === currentId);
  const pageIndex = rawIndex >= 0 ? rawIndex : Math.max(0, pages.length - 1);
  const page = pages[pageIndex];

  // Keep currentId valid when the visible list shrinks the current page away
  // (e.g. selectedMode toggles a conditioned page off while it's current).
  useEffect(() => {
    if (pages.length === 0) return;
    if (!pages.some((p) => p.id === currentId)) {
      setCurrentId(pages[Math.min(pageIndex, pages.length - 1)].id);
    }
  }, [pages, currentId, pageIndex]);

  /** Advance to the NEXT VISIBLE page after the current one (clamped at last). */
  const onAdvance = () => {
    const idx = pages.findIndex((p) => p.id === currentId);
    const base = idx >= 0 ? idx : pageIndex;
    const next = pages[Math.min(base + 1, pages.length - 1)];
    if (next) setCurrentId(next.id);
  };

  function complete() {
    // markOnboardingComplete owns the localStorage write AND flips the reactive
    // store field so App dismisses the wizard immediately (FLUX-758).
    markOnboardingComplete();
    notifyWorkspaceSet();
  }

  function skip() {
    markOnboardingComplete();
    // notifyWorkspaceSet will re-evaluate workspaceConfigured — if no folder was
    // picked yet the WorkspaceSelector will take over from App.tsx.
    notifyWorkspaceSet();
  }

  // Step 1 — folder. The primary Browse button opens the in-app styled
  // DirectoryPicker (FLUX-758); the native OS dialog stays available as a
  // secondary "Use system dialog" affordance.
  function handleBrowse() {
    setBrowseOpen(true);
  }

  async function handleSystemBrowse() {
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
      // Save user name to config if provided
      const trimmedName = userName.trim();
      if (trimmedName) {
        const cfg = await fetchConfig();
        // Drop the 'You' placeholder seeded by bootstrap (FLUX-785) now that we have a real name.
        const existingUsers = (cfg.users || []).filter((u) => u.name && u.name.toLowerCase() !== 'you');
        const hasUser = existingUsers.some((u) => u.name === trimmedName);
        const hasAgent = existingUsers.some((u) => u.name === 'Agent');
        const newUsers = [
          ...(hasUser ? [] : [{ name: trimmedName }]),
          ...existingUsers,
          ...(hasAgent ? [] : [{ name: 'Agent' }]),
        ];
        await apiSaveConfig({ ...cfg, users: newUsers });
        // FLUX-785: actually adopt the name as the active identity (the wizard wrote it to config
        // but never set currentUser, so attribution stayed at the 'Guy' default).
        setCurrentUser(trimmedName);
      }
      onAdvance();
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : 'Failed to open workspace.');
    } finally {
      setFolderLoading(false);
    }
  }

  // Step 2 — sync mode (FLUX-758). 3-way: if the selection already matches the
  // workspace's current mode (or we couldn't detect it), Continue is a no-op that
  // just advances — this fixes the orphan dead-end where an already-orphan user
  // hit migrateStorage()'s "Already in orphan mode" guard. Only an actual change
  // runs a migration: in-repo→orphan via migrateStorage, orphan→in-repo via
  // restoreStorage.
  async function handleModeConfirm() {
    if (currentMode === null || selectedMode === currentMode) {
      onAdvance();
      return;
    }
    setModeLoading(true);
    setModeError(null);
    try {
      if (selectedMode === 'orphan') {
        await migrateStorage();
      } else {
        await restoreStorage();
      }
      onAdvance();
    } catch (err) {
      setModeError(err instanceof Error ? err.message : 'Switching storage mode failed. You can continue with In-Repo mode instead.');
    } finally {
      setModeLoading(false);
    }
  }

  // Step 3 — install
  async function handleInstall() {
    setInstalling(true);
    setInstallError(null);
    try {
      await installWorkspaceSkill(selectedFramework);
      setInstallDone(true);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Installation failed.');
    } finally {
      setInstalling(false);
    }
  }

  function handleSkipInstall() {
    localStorage.setItem(SKIP_INSTALL_KEY, 'true');
    // Advance to the next VISIBLE page rather than a hard jump to 'bootstrap':
    // if bootstrap is hidden/conditioned out, goTo('bootstrap') would be a no-op
    // and the install step would dead-end with no exit (FLUX-763 risk).
    onAdvance();
  }

  // FLUX-758: on entering the storage-mode step, detect the workspace's actual
  // current mode and pre-select the matching card. The workspace was already set
  // by handleOpenFolder → setWorkspace, so this requireWorkspace-gated endpoint
  // resolves. A user already in orphan/git-sync mode lands with the Git Sync card
  // pre-selected and can hit Continue with no migration (no dead-end).
  useEffect(() => {
    if (page?.widget !== 'storage-mode') return;
    fetchStorageMode()
      .then(({ mode }) => {
        setCurrentMode(mode);
        setSelectedMode(mode);
      })
      .catch(() => setCurrentMode('in-repo'));
  }, [page?.widget]);

  // Step 6 — PATH setup. Keyed on the current page being the 'path-setup' widget
  // (was step===6) so the fetch follows the page identity, not a literal index.
  useEffect(() => {
    if (page?.widget !== 'path-setup') return;
    fetchPathInfo().then(setPathInfo).catch(() => setPathInfo({ binaryDir: null, isPkg: false, platform: '' }));
  }, [page?.widget]);

  async function handlePathSetup(mode: 'auto' | 'instructional') {
    setPathAction(mode);
    setPathLoading(true);
    setPathError(null);
    try {
      const result = await setupPath(mode);
      setPathSnippet(result.snippet);
      setPathDone(mode === 'auto');
    } catch (err) {
      setPathError(err instanceof Error ? err.message : 'Failed to update PATH.');
    } finally {
      setPathLoading(false);
    }
  }

  function handleCopySnippet() {
    if (!pathSnippet) return;
    navigator.clipboard.writeText(pathSnippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Step 8 — docs
  function handleGoDocs() {
    complete();
    setView('docs');
  }

  // Step 9 — finish
  function handleFirstTicket() {
    complete();
  }

  // ---------------------------------------------------------------------------
  // WIDGET_RENDERERS — one closure per OnboardingWidgetId. Each is the original
  // step JSX MOVED VERBATIM, closing over the shared state + handlers above. The
  // only mechanical substitutions are setStep(n) → onAdvance() and the install
  // skip's setStep(5) → goTo('bootstrap'). NO state was lifted; NO markup rewritten.
  // ---------------------------------------------------------------------------
  const WIDGET_RENDERERS: Record<OnboardingWidgetId, () => ReactNode> = {
    'pick-folder': () => (
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
            (or{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
              .flux-store/
            </code>
            ) directory automatically if it doesn't exist. You can also run{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
              event-horizon init
            </code>{' '}
            manually as an alternative.
          </p>
        </div>

        <form onSubmit={handleOpenFolder} className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/5">
            <User className="h-5 w-5 shrink-0 text-gray-400" />
            <input
              autoFocus
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Your name"
              className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
            />
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/5">
            <FolderOpen className="h-5 w-5 shrink-0 text-gray-400" />
            <input
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
              className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
            >
              Browse
            </button>
          </div>

          <button
            type="button"
            onClick={handleSystemBrowse}
            disabled={picking}
            className="self-start text-xs text-gray-400 underline-offset-2 transition-colors hover:text-gray-600 hover:underline disabled:opacity-50 dark:text-gray-500 dark:hover:text-gray-300"
          >
            {picking ? 'Opening system dialog…' : 'Use system dialog instead'}
          </button>

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
    ),

    'storage-mode': () => (
      <div>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
            <HardDrive className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Choose your storage mode
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            Pick how Event Horizon stores your tickets. You can change this later in Settings.
          </p>
        </div>

        <div className="flex flex-col gap-3 mb-6">
          {/* In-Repo card */}
          <button
            aria-pressed={selectedMode === 'in-repo'}
            onClick={() => { setSelectedMode('in-repo'); setModeError(null); }}
            className={`rounded-2xl border p-4 text-left transition-all ${
              selectedMode === 'in-repo'
                ? 'border-primary bg-primary/10'
                : 'border-gray-200 bg-white hover:border-primary/50 dark:border-white/10 dark:bg-white/5'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <HardDrive className={`h-5 w-5 shrink-0 ${selectedMode === 'in-repo' ? 'text-primary' : 'text-gray-400'}`} />
              <span className={`font-semibold text-sm ${selectedMode === 'in-repo' ? 'text-primary' : 'text-gray-900 dark:text-white'}`}>
                In-Repo
                <span className="ml-2 text-xs font-normal opacity-60">(default)</span>
              </span>
            </div>
            <ul className="ml-8 space-y-1 text-xs text-gray-500 dark:text-gray-400 list-disc list-inside">
              <li>Tickets live in <code className="rounded bg-gray-100 px-1 dark:bg-white/10">.flux/</code> alongside your code</li>
              <li>No extra git setup — works out of the box</li>
              <li>Ticket history appears in your code commits</li>
            </ul>
            <p className="ml-8 mt-2 text-xs text-gray-400 dark:text-gray-500">
              <strong>Best for:</strong> solo projects or teams that don't mind tickets in git history
            </p>
          </button>

          {/* Git Sync / Orphan card — recommended (FLUX-758): persistent ring/glow
              draws the eye even when not selected; selected state still clearly wins. */}
          <button
            aria-pressed={selectedMode === 'orphan'}
            onClick={() => { setSelectedMode('orphan'); setModeError(null); }}
            className={`rounded-2xl border p-4 text-left transition-all ${
              selectedMode === 'orphan'
                ? 'border-primary bg-primary/10'
                : 'border-gray-200 bg-white hover:border-primary/50 ring-1 ring-primary/30 shadow-[0_0_0_3px_rgba(99,102,241,0.08)] dark:border-white/10 dark:bg-white/5'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <GitBranch className={`h-5 w-5 shrink-0 ${selectedMode === 'orphan' ? 'text-primary' : 'text-gray-400'}`} />
              <span className={`font-semibold text-sm ${selectedMode === 'orphan' ? 'text-primary' : 'text-gray-900 dark:text-white'}`}>
                Git Sync
                <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Recommended</span>
              </span>
            </div>
            <ul className="ml-8 space-y-1 text-xs text-gray-500 dark:text-gray-400 list-disc list-inside">
              <li>Tickets live on a separate <code className="rounded bg-gray-100 px-1 dark:bg-white/10">flux-data</code> orphan branch</li>
              <li>Never touches your main commit graph</li>
              <li>Sync across machines via <code className="rounded bg-gray-100 px-1 dark:bg-white/10">git push/pull</code></li>
              <li>Requires a git repo with a remote</li>
            </ul>
            <p className="ml-8 mt-2 text-xs text-gray-400 dark:text-gray-500">
              <strong>Best for:</strong> teams or multi-machine workflows that want clean history
            </p>
          </button>
        </div>

        {modeError && (
          <div className="mb-4 flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{modeError}</span>
            </div>
            <button
              onClick={() => { setSelectedMode('in-repo'); setModeError(null); onAdvance(); }}
              className="self-start ml-6 text-xs underline underline-offset-2 hover:no-underline"
            >
              Switch to In-Repo and continue
            </button>
          </div>
        )}

        <button
          onClick={handleModeConfirm}
          disabled={modeLoading}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {modeLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {selectedMode === 'orphan' ? 'Setting up Git Sync…' : 'Switching to In-Repo…'}
            </>
          ) : (
            'Continue →'
          )}
        </button>
      </div>
    ),

    'pick-assistant': () => (
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
          onClick={() => onAdvance()}
          className="flex h-11 w-full items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
        >
          Continue →
        </button>
      </div>
    ),

    'install-skill': () => (
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
              onClick={() => onAdvance()}
              className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
            >
              Continue →
            </button>
          )}
        </div>
      </div>
    ),

    'bootstrap': () => (
      <div>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
            <Package className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Import from your project
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            Let's check if your project has docs or tasks we can import.
          </p>
        </div>
        <BootstrapPreview onComplete={() => onAdvance()} onSkip={() => onAdvance()} />
      </div>
    ),

    'path-setup': () => (
      <div>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
            <Terminal className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Add to PATH
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            Run <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">event-horizon</code> from any terminal without typing its full path.
          </p>
        </div>

        {pathInfo === null ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : !pathInfo.isPkg ? (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
            <CheckCircle className="h-5 w-5 shrink-0" />
            <span>Already in PATH via npm — nothing to do.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pathError && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{pathError}</span>
              </div>
            )}

            {pathDone && (
              <div className="mb-2 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                <CheckCircle className="h-5 w-5 shrink-0" />
                <span>PATH updated! Restart your terminal for it to take effect.</span>
              </div>
            )}

            {pathSnippet && pathAction === 'instructional' && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Run this in your terminal</span>
                  <button
                    onClick={handleCopySnippet}
                    className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <code className="block break-all font-mono text-xs text-gray-800 dark:text-gray-200">{pathSnippet}</code>
              </div>
            )}

            {!pathDone && (
              <button
                onClick={() => handlePathSetup('auto')}
                disabled={pathLoading && pathAction === 'auto'}
                className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:opacity-50"
              >
                {pathLoading && pathAction === 'auto' ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Adding…</>
                ) : 'Add automatically'}
              </button>
            )}

            {!pathDone && !pathSnippet && (
              <button
                onClick={() => handlePathSetup('instructional')}
                disabled={pathLoading && pathAction === 'instructional'}
                className="flex h-11 items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
              >
                {pathLoading && pathAction === 'instructional' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : 'Show me the command'}
              </button>
            )}
          </div>
        )}

        <button
          onClick={() => onAdvance()}
          className="mt-3 flex h-11 w-full items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
        >
          {pathDone ? 'Continue →' : 'Skip'}
        </button>
      </div>
    ),

    'completion': () => (
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

        <p className="mt-4 text-center text-xs text-gray-400 dark:text-gray-500">
          Working across several repos that form one product? You can link them into a
          <button
            onClick={() => { markOnboardingComplete(); setView('settings'); }}
            className="ml-1 font-medium text-primary hover:underline"
          >
            multi-repo group
          </button>
          {' '}later from Settings — entirely optional.
        </p>
      </div>
    ),
  };

  // ---------------------------------------------------------------------------
  // CONTENT_ACTIONS — maps a content-page cta `action` to its handler. Reproduces
  // the exact behavior of the old step 7/8 buttons.
  // ---------------------------------------------------------------------------
  const CONTENT_ACTIONS: Record<string, () => void> = {
    advance: () => onAdvance(),
    'open-docs': () => handleGoDocs(),
    'first-ticket': () => handleFirstTicket(),
    'open-group': () => { markOnboardingComplete(); setView('settings'); },
  };

  /**
   * Content pages (features, docs) render through the SHARED OnboardingContentPage
   * (FLUX-760) so the real wizard and the dev Studio preview are pixel-identical by
   * construction. The wizard injects its real CONTENT_ACTIONS dispatcher as `onCta`;
   * the preview injects a no-op. Page/feature images render inside the shared component.
   */
  function renderContentPage(p: OnboardingPage): ReactNode {
    return (
      <OnboardingContentPage
        page={p}
        features={FEATURE_PANELS}
        onCta={(action) => CONTENT_ACTIONS[action]?.()}
      />
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-bg-dark p-8">
      <div className="w-full max-w-lg">
        <StepDots current={pageIndex + 1} total={pages.length} />

        {page && (page.kind === 'widget' && page.widget
          ? WIDGET_RENDERERS[page.widget]()
          : renderContentPage(page))}

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

      {/* FLUX-758: in-app folder browser (replaces the native OS dialog). */}
      {browseOpen && (
        <DirectoryPicker
          onPick={(picked) => {
            setFolderPath(picked);
            setBrowseOpen(false);
          }}
          onClose={() => setBrowseOpen(false)}
        />
      )}
    </div>
  );
}
