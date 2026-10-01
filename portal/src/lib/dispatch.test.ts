import { describe, it, expect } from 'vitest';
import { DISPATCH_PHASE_LABEL, taskHasOneshotSession } from './dispatch';
import type { Task } from '../types';

describe('DISPATCH_PHASE_LABEL (FLUX-1733)', () => {
  it('labels fast-path as oneshot (engine id unchanged)', () => {
    expect(DISPATCH_PHASE_LABEL['fast-path']).toBe('oneshot');
  });
});

describe('taskHasOneshotSession (FLUX-1733)', () => {
  it('is true for a live fast-path session', () => {
    expect(taskHasOneshotSession({
      cliSession: { phase: 'fast-path' } as Task['cliSession'],
    })).toBe(true);
  });

  it('is true for a recent cliSessions entry even after the session ends', () => {
    expect(taskHasOneshotSession({
      cliSession: null,
      cliSessions: [{ phase: 'fast-path', status: 'completed' } as NonNullable<Task['cliSessions']>[number]],
    })).toBe(true);
  });

  it('is false when no fast-path session is present', () => {
    expect(taskHasOneshotSession({
      cliSession: { phase: 'implementation' } as Task['cliSession'],
      cliSessions: [{ phase: 'grooming' } as NonNullable<Task['cliSessions']>[number]],
    })).toBe(false);
    expect(taskHasOneshotSession({})).toBe(false);
  });
});
