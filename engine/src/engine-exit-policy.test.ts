import { describe, it, expect } from 'vitest';
import { decideAfterEngineExit, RESTART_EXIT_CODE, MAX_CRASHES_IN_WINDOW, CRASH_WINDOW_MS } from './engine-exit-policy.js';

// FLUX-1797: the dev supervisor's exit policy.
const base = { code: 1, signal: null, restartPending: false, stopping: false, recentCrashTimes: [] as number[], now: 10_000_000 };

describe('decideAfterEngineExit', () => {
  it('never respawns while the supervisor itself is stopping', () => {
    expect(decideAfterEngineExit({ ...base, stopping: true, code: RESTART_EXIT_CODE })).toEqual({ action: 'stop', reason: 'supervisor stopping' });
  });

  it('respawns immediately on the restart exit code or a pending watcher restart', () => {
    expect(decideAfterEngineExit({ ...base, code: RESTART_EXIT_CODE })).toMatchObject({ action: 'respawn', delayMs: 0, crash: false });
    expect(decideAfterEngineExit({ ...base, code: 0, restartPending: true })).toMatchObject({ action: 'respawn', delayMs: 0, crash: false });
  });

  it('stays down after a clean exit (Ctrl-C on the engine, /api/shutdown)', () => {
    expect(decideAfterEngineExit({ ...base, code: 0 })).toEqual({ action: 'stop', reason: 'clean exit' });
  });

  it('respawns a crash or a signal kill with doubling backoff', () => {
    expect(decideAfterEngineExit({ ...base, code: 1 })).toMatchObject({ action: 'respawn', delayMs: 1_000, crash: true });
    expect(decideAfterEngineExit({ ...base, code: null, signal: 'SIGKILL' })).toMatchObject({ action: 'respawn', crash: true });
    const third = decideAfterEngineExit({ ...base, recentCrashTimes: [base.now - 1_000, base.now - 2_000] });
    expect(third).toMatchObject({ action: 'respawn', delayMs: 4_000 });
  });

  it('ignores crashes outside the window', () => {
    const old = Array.from({ length: 10 }, (_, i) => base.now - CRASH_WINDOW_MS - 1 - i);
    expect(decideAfterEngineExit({ ...base, recentCrashTimes: old })).toMatchObject({ action: 'respawn', delayMs: 1_000 });
  });

  it('stops after a crash loop', () => {
    const loop = Array.from({ length: MAX_CRASHES_IN_WINDOW }, (_, i) => base.now - 1_000 * (i + 1));
    const d = decideAfterEngineExit({ ...base, recentCrashTimes: loop });
    expect(d.action).toBe('stop');
    expect(d.reason).toMatch(/crash loop/);
  });
});
