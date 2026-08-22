// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { SYSTEM_PAGE_SPECS } from './onboardingFlow';
import { WIDGET_SKIP, actionableSteps, readSkippedSteps, recordSkippedSteps, clearSkippedStep, clearSkippedSteps } from './onboardingSkips';
import type { OnboardingPage } from './onboardingFlow';

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

// FLUX-1684: regression guard for the duplicate-control hazard — a new skippable widget
// that forgets to declare its skip ownership must fail loudly here, not ship a page with
// two skip controls (or none).
describe('WIDGET_SKIP guard (FLUX-1684)', () => {
  it('every SYSTEM_PAGE_SPECS entry with required:false declares own or footer', () => {
    for (const [widget, spec] of Object.entries(SYSTEM_PAGE_SPECS)) {
      if (spec.required === false) {
        expect(['own', 'footer']).toContain(WIDGET_SKIP[widget as keyof typeof WIDGET_SKIP]);
      }
    }
  });
});

function widgetPage(id: string, widget: OnboardingPage['widget']): OnboardingPage {
  return { id, kind: 'widget', widget, title: id };
}

function contentPage(id: string): OnboardingPage {
  return { id, kind: 'content', title: id };
}

describe('actionableSteps (FLUX-1684)', () => {
  const pages: OnboardingPage[] = [
    widgetPage('welcome', 'pick-folder'),
    contentPage('features'),
    widgetPage('storage-mode', 'storage-mode'),
    widgetPage('pick-assistant', 'pick-assistant'),
    widgetPage('install-skill', 'install-skill'),
    widgetPage('path-setup', 'path-setup'),
    contentPage('docs'),
    widgetPage('bootstrap', 'bootstrap'),
    widgetPage('all-set', 'completion'),
  ];

  it('excludes content pages, the completion widget, and the final entry', () => {
    const ids = actionableSteps(pages).map((p) => p.id);
    expect(ids).toEqual(['welcome', 'storage-mode', 'pick-assistant', 'install-skill', 'path-setup', 'bootstrap']);
  });

  it('includes the current page when slicing from a mid-flow index (skip-all from path-setup)', () => {
    const fromIndex = pages.findIndex((p) => p.id === 'path-setup');
    const ids = actionableSteps(pages, fromIndex).map((p) => p.id);
    expect(ids).toEqual(['path-setup', 'bootstrap']);
  });

  it('never includes the terminal completion page even when it is the only remaining entry', () => {
    const fromIndex = pages.findIndex((p) => p.id === 'all-set');
    expect(actionableSteps(pages, fromIndex)).toEqual([]);
  });
});

describe('readSkippedSteps / recordSkippedSteps / clearSkippedStep (FLUX-1684)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads [] for a missing key', () => {
    expect(readSkippedSteps()).toEqual([]);
  });

  it('reads [] for a non-array or garbage value and never throws', () => {
    localStorage.setItem('eh-onboarding-skipped', '{"not":"an array"}');
    expect(readSkippedSteps()).toEqual([]);
    localStorage.setItem('eh-onboarding-skipped', 'not even json');
    expect(readSkippedSteps()).toEqual([]);
  });

  it('unions and de-dupes recorded ids', () => {
    recordSkippedSteps(['install-skill']);
    recordSkippedSteps(['path-setup', 'install-skill']);
    expect(readSkippedSteps().sort()).toEqual(['install-skill', 'path-setup']);
  });

  it('clearSkippedStep removes exactly one id', () => {
    recordSkippedSteps(['install-skill', 'path-setup']);
    clearSkippedStep('install-skill');
    expect(readSkippedSteps()).toEqual(['path-setup']);
  });

  it('clearSkippedSteps empties the set', () => {
    recordSkippedSteps(['install-skill']);
    clearSkippedSteps();
    expect(readSkippedSteps()).toEqual([]);
  });
});
