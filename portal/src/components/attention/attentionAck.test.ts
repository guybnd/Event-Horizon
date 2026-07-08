// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePlanReviewDockDismiss } from './attentionAck';

// Node's own experimental `localStorage` global shadows jsdom's real one in this vitest setup
// (it exists but throws/no-ops without `--localstorage-file`), so the bare `localStorage` the hook
// reads/writes needs a working stand-in here — an in-memory Map is enough to exercise the
// persistence contract without depending on a real browser storage backend.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('usePlanReviewDockDismiss (FLUX-1289)', () => {
  it('is not dismissed by default', () => {
    const { result } = renderHook(() => usePlanReviewDockDismiss());
    expect(result.current.isDockDismissed('FLUX-1', 'changes-requested')).toBe(false);
  });

  it('dismisses only the exact ticket id + verdict pair', () => {
    const { result } = renderHook(() => usePlanReviewDockDismiss());
    act(() => result.current.dockDismiss('FLUX-1', 'changes-requested'));
    expect(result.current.isDockDismissed('FLUX-1', 'changes-requested')).toBe(true);
    // a different verdict on the same ticket is untouched
    expect(result.current.isDockDismissed('FLUX-1', 'approved')).toBe(false);
    // a different ticket is untouched
    expect(result.current.isDockDismissed('FLUX-2', 'changes-requested')).toBe(false);
  });

  it('re-arms on a fresh verdict — dismissing changes-requested does not suppress a later approved (or vice versa)', () => {
    const { result } = renderHook(() => usePlanReviewDockDismiss());
    act(() => result.current.dockDismiss('FLUX-1', 'changes-requested'));
    // the ticket is re-reviewed and now reads "approved" — a NEW verdict key, so it re-arms.
    expect(result.current.isDockDismissed('FLUX-1', 'approved')).toBe(false);
  });

  it('persists across remounts via localStorage (survives a reload)', () => {
    const first = renderHook(() => usePlanReviewDockDismiss());
    act(() => first.result.current.dockDismiss('FLUX-1', 'changes-requested'));
    first.unmount();

    const second = renderHook(() => usePlanReviewDockDismiss());
    expect(second.result.current.isDockDismissed('FLUX-1', 'changes-requested')).toBe(true);
  });
});
