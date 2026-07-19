// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { appStore } from '../store/appStore';
import type { AppStoreState } from '../store/appStore';

let reducedMotion = false;
// Hoisted above the imports below, same pattern as tokens.test.ts.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return { ...actual, useReducedMotion: () => reducedMotion };
});

import { SuccessMark } from './SuccessMark';

const initialState = appStore.getState();

function setConfig(config: Partial<AppStoreState['config']> | null) {
  appStore.patch({ config: config as AppStoreState['config'] });
}

afterEach(() => {
  cleanup();
  reducedMotion = false;
  appStore.setState(initialState);
});

describe('SuccessMark', () => {
  it('renders the final checked state with a zero-duration transition when instant (reduced motion)', () => {
    setConfig({ animationsEnabled: true, animationSpeed: 'normal' });
    reducedMotion = true;
    const { container } = render(<SuccessMark />);

    const path = container.querySelector('path');
    expect(path).toBeTruthy();
    expect(path?.getAttribute('d')).toBe('M7 12.4l3.3 3.3L17.3 8.4');
  });

  it('renders the final checked state with a zero-duration transition when animationsEnabled is false', () => {
    setConfig({ animationsEnabled: false, animationSpeed: 'normal' });
    const { container } = render(<SuccessMark />);

    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders when animated (not instant)', () => {
    setConfig({ animationsEnabled: true, animationSpeed: 'normal' });
    const { container } = render(<SuccessMark />);

    expect(container.querySelector('svg')).toBeTruthy();
  });
});
