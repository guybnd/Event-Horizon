// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSessionOutput } from './useSessionOutput';
import * as api from '../api';
import type { CliSessionSummary } from '../types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeSession(overrides: Partial<CliSessionSummary> = {}): CliSessionSummary {
  return {
    id: 'session-1',
    taskId: 'FLUX-1',
    status: 'completed',
    liveOutput: 'tail output',
    ...overrides,
  } as CliSessionSummary;
}

describe('useSessionOutput', () => {
  it('returns the tail as-is with no fetch when the session is not truncated', () => {
    const fetchSpy = vi.spyOn(api, 'fetchSessionOutput');
    const session = makeSession();
    const { result } = renderHook(({ expanded }) => useSessionOutput(session, expanded), {
      initialProps: { expanded: true },
    });
    expect(result.current).toEqual({ text: 'tail output', loading: false, notAvailable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch while collapsed, even if truncated', () => {
    const fetchSpy = vi.spyOn(api, 'fetchSessionOutput').mockResolvedValue('full output');
    const session = makeSession({ liveOutputChars: 4096 });
    renderHook(({ expanded }) => useSessionOutput(session, expanded), {
      initialProps: { expanded: false },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the full buffer once expanded, and shows a size-hint notice while pending', async () => {
    const fetchSpy = vi.spyOn(api, 'fetchSessionOutput').mockResolvedValue('full output');
    const session = makeSession({ liveOutputChars: 4096 });
    const { result } = renderHook(() => useSessionOutput(session, true));

    expect(result.current.notice).toBe('loading full output…');

    await waitFor(() => expect(result.current.text).toBe('full output'));
    expect(fetchSpy).toHaveBeenCalledWith('FLUX-1', 'session-1');
    expect(result.current.notice).toBeUndefined();
    expect(result.current.notAvailable).toBe(false);
  });

  it('fetches only once per session id across re-expands', async () => {
    const fetchSpy = vi.spyOn(api, 'fetchSessionOutput').mockResolvedValue('full output');
    const session = makeSession({ liveOutputChars: 4096 });
    const { result, rerender } = renderHook(({ expanded }) => useSessionOutput(session, expanded), {
      initialProps: { expanded: true },
    });
    await waitFor(() => expect(result.current.text).toBe('full output'));

    rerender({ expanded: false });
    rerender({ expanded: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a not-available notice and falls back to the tail on a 404', async () => {
    vi.spyOn(api, 'fetchSessionOutput').mockRejectedValue(new Error('Failed to fetch session output'));
    const session = makeSession({ liveOutputChars: 4096 });
    const { result } = renderHook(() => useSessionOutput(session, true));

    await waitFor(() => expect(result.current.notAvailable).toBe(true));
    expect(result.current.text).toBe('tail output');
    expect(result.current.notice).toBe('output no longer available (engine restarted)');
  });
});
