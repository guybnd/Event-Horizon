import { describe, it, expect, afterEach, vi } from 'vitest';
import { warnIfSlowLoadTask } from './load-task-timing.js';
import { log } from '../log.js';

describe('load-task timing (FLUX-1202)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EH_PERF_SLOW_LOAD_TASK_MS;
  });

  it('warns and names the file when a load exceeds the slow threshold (default 500ms)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    warnIfSlowLoadTask('/flux/FLUX-1073.md', 2251);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/slow loadTask/i);
    expect(warnSpy.mock.calls[0]![0]).toContain('FLUX-1073.md');
    expect(warnSpy.mock.calls[0]![0]).toContain('2251ms');
  });

  it('does not warn under the threshold', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    warnIfSlowLoadTask('/flux/FLUX-1.md', 100);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('respects the EH_PERF_SLOW_LOAD_TASK_MS override', () => {
    process.env.EH_PERF_SLOW_LOAD_TASK_MS = '50';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    warnIfSlowLoadTask('/flux/FLUX-1.md', 100);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
