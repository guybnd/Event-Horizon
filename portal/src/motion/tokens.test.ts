// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { appStore } from '../store/appStore';
import type { AppStoreState } from '../store/appStore';

let reducedMotion = false;
// Hoisted by vitest above the imports below — `tokens.ts`'s `useReducedMotion` import
// resolves to this mock regardless of import order in source.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return { ...actual, useReducedMotion: () => reducedMotion };
});

import { useMotionTokens } from './tokens';

const initialState = appStore.getState();

function setConfig(config: Partial<AppStoreState['config']> | null) {
  appStore.patch({ config: config as AppStoreState['config'] });
}

afterEach(() => {
  cleanup();
  reducedMotion = false;
  appStore.setState(initialState);
});

describe('useMotionTokens', () => {
  it('scales fade/press durations and spring stiffness/damping by animationSpeed', () => {
    setConfig({ animationsEnabled: true, animationSpeed: 'normal' });
    const { result: normal } = renderHook(() => useMotionTokens());
    expect(normal.current.instant).toBe(false);
    expect(normal.current.fade).toMatchObject({ duration: 0.22 });
    expect(normal.current.press).toMatchObject({ duration: 0.09 });
    expect(normal.current.spring).toMatchObject({ type: 'spring', stiffness: 400, damping: 32 });

    setConfig({ animationsEnabled: true, animationSpeed: 'fast' });
    const { result: fast } = renderHook(() => useMotionTokens());
    expect(fast.current.fade.duration).toBeCloseTo(0.11);
    expect(fast.current.press.duration).toBeCloseTo(0.045);
    expect(fast.current.spring).toMatchObject({ stiffness: 1600, damping: 64 });

    setConfig({ animationsEnabled: true, animationSpeed: 'slow' });
    const { result: slow } = renderHook(() => useMotionTokens());
    expect(slow.current.fade.duration).toBeCloseTo(0.385);
    expect(slow.current.press.duration).toBeCloseTo(0.1575);
    expect(slow.current.spring).toMatchObject({ stiffness: 400 / (1.75 * 1.75), damping: 32 / 1.75 });
  });

  it('zeroes every duration/drift when animationsEnabled is false, regardless of speed', () => {
    setConfig({ animationsEnabled: false, animationSpeed: 'slow' });
    const { result } = renderHook(() => useMotionTokens());

    expect(result.current.instant).toBe(true);
    expect(result.current.fade).toEqual({ duration: 0 });
    expect(result.current.press).toEqual({ duration: 0 });
    expect(result.current.spring).toEqual({ duration: 0 });
    expect(result.current.springSettleMs).toBe(0);
    expect(result.current.crossfadeDriftPx).toBe(0);
  });

  it('zeroes every duration/drift when prefers-reduced-motion is on, even if animationsEnabled is true', () => {
    setConfig({ animationsEnabled: true, animationSpeed: 'normal' });
    reducedMotion = true;
    const { result } = renderHook(() => useMotionTokens());

    expect(result.current.instant).toBe(true);
    expect(result.current.fade).toEqual({ duration: 0 });
    expect(result.current.crossfadeDriftPx).toBe(0);
  });

  it('keeps crossfadeDirection stable across instant/animated states', () => {
    setConfig({ animationsEnabled: false, animationSpeed: 'normal' });
    const { result: instant } = renderHook(() => useMotionTokens());
    setConfig({ animationsEnabled: true, animationSpeed: 'normal' });
    const { result: animated } = renderHook(() => useMotionTokens());

    expect(instant.current.crossfadeDirection).toBe('down');
    expect(animated.current.crossfadeDirection).toBe('down');
  });
});
