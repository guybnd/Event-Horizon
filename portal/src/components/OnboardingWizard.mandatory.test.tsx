// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingWizard } from './OnboardingWizard';
import { AppActionsContext } from '../store/useAppSelector';
import { appStore } from '../store/appStore';
import type { AppActions } from '../store/appStore';

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

// FLUX-1684: mandatory:true is only exercisable via a hand-authored flow (today's shipped
// onboardingFlow.json has no mandatory pages), so this test mocks the flow config in
// isolation from OnboardingWizard.skip.test.tsx's real-flow suite.
vi.mock('../config/onboardingFlow.json', () => ({
  default: {
    version: 2,
    pages: [
      { id: 'welcome', kind: 'widget', widget: 'pick-folder', title: 'Welcome to Event Horizon' },
      { id: 'storage-mode', kind: 'widget', widget: 'storage-mode', title: 'Choose your storage mode' },
      { id: 'pick-assistant', kind: 'widget', widget: 'pick-assistant', title: 'Pick your AI assistant' },
      { id: 'install-skill', kind: 'widget', widget: 'install-skill', title: 'Install the integration', mandatory: true },
      { id: 'path-setup', kind: 'widget', widget: 'path-setup', title: 'Add to PATH' },
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
    fetchPathInfo: vi.fn().mockResolvedValue({ binaryDir: null, isPkg: false, platform: 'linux' }),
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

describe('OnboardingWizard — mandatory pages suppress skip controls (FLUX-1684)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('hides "Skip all remaining setup" on every page up to and including the mandatory one, and hides "Skip for now" on the mandatory page itself', async () => {
    renderWizard();

    // welcome — mandatory install-skill is still ahead.
    await screen.findByRole('heading', { name: 'Welcome to Event Horizon' });
    expect(screen.queryByText('Skip all remaining setup')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/my-project/), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByText('Open Project →'));

    // storage-mode
    await screen.findByRole('heading', { name: 'Choose your storage mode' });
    expect(screen.queryByText('Skip all remaining setup')).toBeNull();
    fireEvent.click(screen.getByText('Continue →'));

    // pick-assistant
    await screen.findByRole('heading', { name: 'Pick your AI assistant' });
    expect(screen.queryByText('Skip all remaining setup')).toBeNull();
    fireEvent.click(screen.getByText('Continue →'));

    // install-skill — the mandatory page itself: no pure-skip control at all.
    await screen.findByRole('heading', { name: 'Install the integration' });
    expect(screen.queryByText('Skip for now')).toBeNull();
    expect(screen.queryByText('Skip all remaining setup')).toBeNull();

    fireEvent.click(screen.getByText('Install now'));
    await screen.findByText('Integration installed successfully!');
    fireEvent.click(screen.getByText('Continue →'));

    // path-setup — past the mandatory page: skip-all is available again.
    await screen.findByRole('heading', { name: 'Add to PATH' });
    expect(screen.getByText('Skip all remaining setup')).toBeTruthy();
  });
});
