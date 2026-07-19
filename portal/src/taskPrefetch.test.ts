import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './types';

vi.mock('./api', () => ({
  fetchTask: vi.fn(),
}));

import { fetchTask } from './api';
import { __resetTaskPrefetchForTests, fetchTaskCached, peekTask, prefetchTask } from './taskPrefetch';

const mockFetchTask = fetchTask as ReturnType<typeof vi.fn>;

function makeTask(id: string): Task {
  return { id, title: `Task ${id}`, status: 'Todo' } as Task;
}

describe('taskPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchTask.mockReset();
    __resetTaskPrefetchForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefetchTask twice for one id issues only one underlying fetch', async () => {
    const task = makeTask('FLUX-1');
    mockFetchTask.mockResolvedValue(task);

    prefetchTask('FLUX-1');
    prefetchTask('FLUX-1');
    await vi.runAllTimersAsync();

    expect(mockFetchTask).toHaveBeenCalledTimes(1);
  });

  it('fetchTaskCached after a completed prefetchTask returns the cached value with no second call', async () => {
    const task = makeTask('FLUX-2');
    mockFetchTask.mockResolvedValue(task);

    prefetchTask('FLUX-2');
    await vi.runAllTimersAsync();

    const result = await fetchTaskCached('FLUX-2');
    expect(result).toBe(task);
    expect(mockFetchTask).toHaveBeenCalledTimes(1);
  });

  it('fetchTaskCached consumes the warm entry so a second call goes live (revalidation stays fresh)', async () => {
    const warm = makeTask('FLUX-5');
    mockFetchTask.mockResolvedValueOnce(warm);

    prefetchTask('FLUX-5');
    await vi.runAllTimersAsync();

    const first = await fetchTaskCached('FLUX-5');
    expect(first).toBe(warm);
    expect(mockFetchTask).toHaveBeenCalledTimes(1);

    const live = makeTask('FLUX-5');
    mockFetchTask.mockResolvedValueOnce(live);

    const second = await fetchTaskCached('FLUX-5');
    expect(second).toBe(live);
    expect(mockFetchTask).toHaveBeenCalledTimes(2);
  });

  it('peekTask returns the value inside the TTL and undefined after it expires', async () => {
    const task = makeTask('FLUX-3');
    mockFetchTask.mockResolvedValue(task);

    prefetchTask('FLUX-3');
    await vi.runAllTimersAsync();

    expect(peekTask('FLUX-3')).toBe(task);

    vi.advanceTimersByTime(6000);
    expect(peekTask('FLUX-3')).toBeUndefined();
  });

  it('a rejected fetchTask leaves no poisoned entry and does not throw', async () => {
    mockFetchTask.mockRejectedValueOnce(new Error('boom'));

    expect(() => prefetchTask('FLUX-4')).not.toThrow();
    await vi.runAllTimersAsync();

    expect(peekTask('FLUX-4')).toBeUndefined();

    const task = makeTask('FLUX-4');
    mockFetchTask.mockResolvedValueOnce(task);
    const result = await fetchTaskCached('FLUX-4');
    expect(result).toBe(task);
    expect(mockFetchTask).toHaveBeenCalledTimes(2);
  });
});
