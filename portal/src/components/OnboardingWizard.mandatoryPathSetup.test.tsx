// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingWizard } from './OnboardingWizard';
import { AppActionsContext } from '../store/useAppSelector';
import { appStore } from '../store/appStore';
import type { AppActions } from '../store/appStore';
import { fetchPathInfo } from '../api';

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

// FLUX-1684 review follow-up: path-setup is the one page whose trailing button is a
// forward control, not a pure skip, when PATH is actionable (isPkg). If mandatory
// suppressed that button the way it suppresses the footer/global skips, a mandatory
// path-setup page with an errored "Add automatically" would be a dead end. This test
// pins a dedicated mock flow (mandatory on path-setup, not install-skill) separate from
// OnboardingWizard.mandatory.test.tsx so it doesn't disturb that file's shared config.
vi.mock('../config/onboardingFlow.json', () => ({
  default: {
    version: 2,
    pages: [
      { id: 'welcome', kind: 'widget', widget: 'pick-folder', title: 'Welcome to Event Horizon' },
      { id: 'storage-mode', kind: 'widget', widget: 'storage-mode', title: 'Choose your storage mode' },
      { id: 'pick-assistant', kind: 'widget', widget: 'pick-assistant', title: 'Pick your AI assistant' },
      { id: 'path-setup', kind: 'widget', widget: 'path-setup', title: 'Add to PATH', mandatory: true },
      { id: 'all-set', kind: 'widget', widget: 'completion', title: "You're all set!" },
    ],
  },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    setWorkspace: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/proj' }),
    fetchStorageMode: vi.fn().mockResolvedValue({ mode: 'in-repo' }),
    fetchPathInfo: vi.fn().mockResolvedValue({ binaryDir: '/x', isPkg: true, platform: 'linux' }),
    setupPath: vi.fn().mockResolvedValue({ ok: true, snippet: 'export PATH="/x:$PATH"' }),
    installWorkspaceSkill: vi.fn().mockResolvedValue({ success: true, skillInstalledPath: '/tmp/skill' }),
  };
});

function stubActions(overrides: Partial<AppActions> = {}): AppActions {
  return new Proxy(overrides, { get: (target, prop) => (prop in target ? target[prop as keyof AppActions] : vi.fn()) }) as AppActions;
}

function renderWizard() {
  appStore.patch({ config: null });
  render(
    <AppActionsContext.Provider value={stubActions()}>
      <OnboardingWizard />
    </AppActionsContext.Provider>,
  );
}

describe('OnboardingWizard — mandatory path-setup never dead-ends (FLUX-1684)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // FLUX-1689: the FLUX-1684 fix kept the trailing button unconditionally rendered
  // (removing it entirely reopens the dead end), but that alone let `mandatory` be
  // bypassed with a bare, unacknowledged "Skip". The button must still always be
  // present and eventually reach the next page (no dead end) — it just can no longer
  // advance before the user has engaged with PATH setup in some way.
  it('disables the trailing control until the user engages, then advances without dead-ending', async () => {
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    renderWizard();

    await screen.findByRole('heading', { name: 'Add to PATH' });
    // Mandatory hides the footer/global skip controls...
    expect(screen.queryByText('Skip all remaining setup')).toBeNull();

    // ...but the trailing control is still present — relabeled and disabled, since
    // nothing has been attempted yet.
    const trailingButton = await screen.findByRole('button', { name: "I've added it manually — continue" }) as HTMLButtonElement;
    expect(trailingButton.disabled).toBe(true);
    fireEvent.click(trailingButton);
    expect(screen.getByRole('heading', { name: 'Add to PATH' })).toBeTruthy();

    // Engaging via "Show me the command" is enough acknowledgement to unlock it.
    fireEvent.click(screen.getByText('Show me the command'));
    await screen.findByText('export PATH="/x:$PATH"');
    expect(trailingButton.disabled).toBe(false);

    fireEvent.click(trailingButton);
    await screen.findByRole('heading', { name: "You're all set!" });
  });

  it('unlocks the trailing control on an "Add automatically" error, matching the FLUX-1684 dead-end case', async () => {
    const { setupPath } = await import('../api');
    vi.mocked(setupPath).mockRejectedValueOnce(new Error('permission denied'));
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    renderWizard();

    await screen.findByRole('heading', { name: 'Add to PATH' });
    fireEvent.click(screen.getByText('Add automatically'));
    await screen.findByText('permission denied');

    const trailingButton = screen.getByRole('button', { name: "I've added it manually — continue" }) as HTMLButtonElement;
    expect(trailingButton.disabled).toBe(false);

    fireEvent.click(trailingButton);
    await screen.findByRole('heading', { name: "You're all set!" });
  });

  it('does not let the fetchPathInfo loading window silently bypass a mandatory page', async () => {
    vi.mocked(fetchPathInfo).mockReturnValueOnce(new Promise(() => {})); // never resolves in this test
    localStorage.setItem('eh-onboarding-resume', 'path-setup');
    renderWizard();

    await screen.findByRole('heading', { name: 'Add to PATH' });
    const trailingButton = screen.getByRole('button', { name: 'Continue →' }) as HTMLButtonElement;
    expect(trailingButton.disabled).toBe(true);

    fireEvent.click(trailingButton);
    expect(screen.getByRole('heading', { name: 'Add to PATH' })).toBeTruthy();
  });
});
