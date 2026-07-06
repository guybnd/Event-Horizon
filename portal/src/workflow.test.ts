import { describe, it, expect } from 'vitest';
import { normalizeStatus, UNKNOWN_STATUS, classifyCardSessionState } from './workflow';
import type { Task } from './types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'FLUX-1',
    status: 'In Progress',
    ...overrides,
  } as Task;
}

describe('normalizeStatus', () => {
  it('returns the status unchanged when it is a non-empty string', () => {
    expect(normalizeStatus('In Progress')).toBe('In Progress');
  });

  it('buckets undefined into UNKNOWN_STATUS', () => {
    expect(normalizeStatus(undefined)).toBe(UNKNOWN_STATUS);
  });

  it('buckets null into UNKNOWN_STATUS', () => {
    expect(normalizeStatus(null)).toBe(UNKNOWN_STATUS);
  });

  it('buckets an empty string into UNKNOWN_STATUS', () => {
    expect(normalizeStatus('')).toBe(UNKNOWN_STATUS);
  });

  it('buckets a whitespace-only string into UNKNOWN_STATUS', () => {
    expect(normalizeStatus('   ')).toBe(UNKNOWN_STATUS);
  });

  it('buckets a non-string value into UNKNOWN_STATUS', () => {
    expect(normalizeStatus(42)).toBe(UNKNOWN_STATUS);
  });
});

describe('classifyCardSessionState', () => {
  it('classifies a "failed" polled cliSession status as failed', () => {
    const task = makeTask({ cliSession: { status: 'failed' } as Task['cliSession'] });
    expect(classifyCardSessionState(task, undefined)).toBe('failed');
  });

  it('prefers the live SSE status over the polled cliSession status', () => {
    const task = makeTask({ cliSession: { status: 'running' } as Task['cliSession'] });
    expect(classifyCardSessionState(task, 'failed')).toBe('failed');
  });

  it('does not treat "failed" as pending user input (distinct from needs-input)', () => {
    // needsAction is set alongside a crashed session, but 'failed' must win over the
    // pendingUser branch so the card reads as an alarm, not a calm "needs your input".
    const task = makeTask({ cliSession: { status: 'failed' } as Task['cliSession'], needsAction: 'parked' });
    expect(classifyCardSessionState(task, undefined)).toBe('failed');
  });
});
