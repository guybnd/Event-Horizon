// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { GeneralSection } from './GeneralSection';

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

function renderSection() {
  render(
    <GeneralSection
      defaultUser=""
      setDefaultUser={vi.fn()}
      preferredFramework=""
      setPreferredFramework={vi.fn()}
      port={3067}
      setPort={vi.fn()}
      globalLoading={false}
      globalError={null}
    />,
  );
}

describe('GeneralSection — Finish setup card (FLUX-1684)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders no card when nothing is recorded skipped', async () => {
    renderSection();
    await waitFor(() => expect(screen.queryByText(/Finish setup —/)).toBeNull());
  });

  it('renders no card when the recorded ids are all unknown/non-actionable', async () => {
    localStorage.setItem('eh-onboarding-skipped', JSON.stringify(['nonexistent-page', 'all-set']));
    renderSection();
    await waitFor(() => expect(screen.queryByText(/Finish setup —/)).toBeNull());
  });

  it('renders the card with matching titles and writes eh-onboarding-resume on click', async () => {
    localStorage.setItem('eh-onboarding-skipped', JSON.stringify(['install-skill', 'path-setup']));
    renderSection();

    await screen.findByText('Finish setup — 2 steps skipped');
    expect(screen.getByText('Install the integration · Add to PATH')).toBeTruthy();

    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true, configurable: true });

    screen.getByText('Finish setup').click();

    expect(localStorage.getItem('eh-onboarding-resume')).toBe('install-skill');
    expect(localStorage.getItem('eh-onboarding-complete')).toBeNull();
    expect(reload).toHaveBeenCalled();
  });
});
