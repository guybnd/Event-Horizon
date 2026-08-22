// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OnboardingWizard } from './OnboardingWizard';
import { AppActionsContext } from '../store/useAppSelector';
import { appStore } from '../store/appStore';
import type { AppActions } from '../store/appStore';
import { readSkippedSteps } from '../config/onboardingSkips';

// jsdom in this environment doesn't provide localStorage unless launched with
// --localstorage-file (see AppContext.idle.test.tsx for the same fix).
if (!window.localStorage) {
  const backing = new Map<string, string>();
  // @ts-expect-error minimal in-memory localStorage polyfill for this environment
  window.localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); },
    clear: () => backing.clear(),
  };
}

// FLUX-1684: net-new coverage — no OnboardingWizard tests existed before this ticket.
// Mirrors Board.test.tsx's pattern (real appStore + AppActionsContext.Provider) rather
// than mocking the whole store module, so the real useConfig()/useAppActions() hooks run.

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    setWorkspace: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/proj' }),
    fetchStorageMode: vi.fn().mockResolvedValue({ mode: 'in-repo' }),
    fetchPathInfo: vi.fn().mockResolvedValue({ binaryDir: null, isPkg: false, platform: 'linux' }),
    installWorkspaceSkill: vi.fn().mockResolvedValue({ success: true, skillInstalledPath: '/tmp/skill' }),
  };
});

function stubActions(overrides: Partial<AppActions> = {}): AppActions {
  return new Proxy(overrides, { get: (target, prop) => (prop in target ? target[prop as keyof AppActions] : vi.fn()) }) as AppActions;
}

function renderWizard(actionOverrides: Partial<AppActions> = {}) {
  appStore.patch({ config: null });
  const actions = stubActions(actionOverrides);
  render(
    <AppActionsContext.Provider value={actions}>
      <OnboardingWizard />
    </AppActionsContext.Provider>,
  );
  return actions;
}

describe('OnboardingWizard — per-step skip (FLUX-1684)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('first click of "Skip all remaining setup" does not complete onboarding; "Keep setting up" dismisses it', async () => {
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    const markOnboardingComplete = vi.fn();
    renderWizard({ markOnboardingComplete });

    await screen.findByRole('heading', { name: 'Add to PATH' });

    fireEvent.click(screen.getByText('Skip all remaining setup'));
    expect(screen.getByText('This abandons: Add to PATH, Import from your project')).toBeTruthy();
    expect(markOnboardingComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Keep setting up'));
    expect(screen.queryByText('Keep setting up')).toBeNull();
    expect(markOnboardingComplete).not.toHaveBeenCalled();
  });

  it('"Skip all N and finish" completes onboarding once and records exactly the actionable ids from the current page onward', async () => {
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    const markOnboardingComplete = vi.fn();
    renderWizard({ markOnboardingComplete });

    await screen.findByRole('heading', { name: 'Add to PATH' });

    fireEvent.click(screen.getByText('Skip all remaining setup'));
    fireEvent.click(screen.getByText('Skip all 2 and finish'));

    expect(markOnboardingComplete).toHaveBeenCalledTimes(1);
    expect(readSkippedSteps().sort()).toEqual(['bootstrap', 'path-setup']);
  });

  it('install-skill\'s "Skip for now" advances one page, sets onboarding-install-skipped, records install-skill, never completes onboarding', async () => {
    localStorage.setItem('eh-onboarding-resume', 'install-skill');
    const markOnboardingComplete = vi.fn();
    renderWizard({ markOnboardingComplete });

    await screen.findByRole('heading', { name: 'Install the integration' });
    fireEvent.click(screen.getByText('Skip for now'));

    await screen.findByRole('heading', { name: 'Add to PATH' });
    expect(localStorage.getItem('onboarding-install-skipped')).toBe('true');
    expect(readSkippedSteps()).toEqual(['install-skill']);
    expect(markOnboardingComplete).not.toHaveBeenCalled();
  });

  it('advancing off a page via its normal action un-records it from eh-onboarding-skipped', async () => {
    localStorage.setItem('eh-onboarding-resume', 'install-skill');
    localStorage.setItem('eh-onboarding-skipped', JSON.stringify(['install-skill']));
    renderWizard();

    await screen.findByRole('heading', { name: 'Install the integration' });
    fireEvent.click(screen.getByText('Install now'));
    await screen.findByText('Integration installed successfully!');
    fireEvent.click(screen.getByText('Continue →'));

    await screen.findByRole('heading', { name: 'Add to PATH' });
    expect(readSkippedSteps()).toEqual([]);
  });

  it('mounts on the resumed step and clears eh-onboarding-resume afterward', async () => {
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    renderWizard();

    await screen.findByRole('heading', { name: 'Add to PATH' });
    await waitFor(() => expect(localStorage.getItem('eh-onboarding-resume')).toBeNull());
  });

  it('"Open the docs" completes onboarding once, navigates to docs, and records the abandoned bootstrap step (FLUX-1688)', async () => {
    localStorage.setItem('eh-onboarding-resume', 'docs');
    const markOnboardingComplete = vi.fn();
    const notifyWorkspaceSet = vi.fn();
    const setView = vi.fn();
    renderWizard({ markOnboardingComplete, notifyWorkspaceSet, setView });

    await screen.findByRole('heading', { name: 'Explore the docs' });
    fireEvent.click(screen.getByText('Open the docs'));

    expect(markOnboardingComplete).toHaveBeenCalledTimes(1);
    expect(notifyWorkspaceSet).toHaveBeenCalledTimes(1);
    expect(setView).toHaveBeenCalledWith('docs');
    expect(readSkippedSteps()).toEqual(['bootstrap']);
  });

  it('when PATH is actionable (isPkg), the trailing button reads "Skip", records path-setup, and advances one page', async () => {
    const { fetchPathInfo } = await import('../api');
    vi.mocked(fetchPathInfo).mockResolvedValue({ binaryDir: '/x', isPkg: true, platform: 'linux' });
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    renderWizard();

    await screen.findByRole('heading', { name: 'Add to PATH' });
    const skipButton = await screen.findByText('Skip');
    fireEvent.click(skipButton);

    await screen.findByRole('heading', { name: 'Explore the docs' });
    expect(readSkippedSteps()).toEqual(['path-setup']);
  });

  it('resuming with a persisted assistant names it correctly and installs against it', async () => {
    localStorage.setItem('eh-onboarding-assistant', 'cursor');
    localStorage.setItem('eh-onboarding-resume', 'install-skill');
    const { installWorkspaceSkill } = await import('../api');
    renderWizard();

    await screen.findByRole('heading', { name: 'Install the integration' });
    expect(screen.getByText('Cursor')).toBeTruthy();

    fireEvent.click(screen.getByText('Install now'));
    await waitFor(() => expect(installWorkspaceSkill).toHaveBeenCalledWith('cursor'));
  });
});
