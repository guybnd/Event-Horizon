import { describe, it, expect } from 'vitest';
import { isLiveInputTarget, SESSION_STALE_MS } from './orchestration';
import type { CliSessionSummary } from './types';

const NOW = new Date('2026-07-16T05:00:00.000Z').getTime();

function makeSession(overrides: Partial<CliSessionSummary> = {}): Pick<CliSessionSummary, 'status' | 'endedAt' | 'resumable' | 'lastOutputAt' | 'startedAt'> {
  return {
    status: 'running',
    startedAt: '2026-07-16T04:55:00.000Z',
    ...overrides,
  };
}

describe('isLiveInputTarget (FLUX-1456)', () => {
  it('treats a running session as live', () => {
    expect(isLiveInputTarget(makeSession({ status: 'running' }), NOW)).toBe(true);
  });

  it('treats a pending session as live', () => {
    expect(isLiveInputTarget(makeSession({ status: 'pending' }), NOW)).toBe(true);
  });

  it('treats any terminal (endedAt set) session as not live, even if status is stuck on running', () => {
    expect(isLiveInputTarget(makeSession({ status: 'running', endedAt: '2026-07-16T04:59:00.000Z' }), NOW)).toBe(false);
  });

  it('treats a non-resumable waiting-input session as not live (parked, no way back in)', () => {
    expect(isLiveInputTarget(makeSession({ status: 'waiting-input', resumable: false, lastOutputAt: '2026-07-16T04:59:00.000Z' }), NOW)).toBe(false);
  });

  it('treats a resumable waiting-input session with recent output as live', () => {
    const lastOutputAt = new Date(NOW - 60_000).toISOString(); // 1 min ago
    expect(isLiveInputTarget(makeSession({ status: 'waiting-input', resumable: true, lastOutputAt }), NOW)).toBe(true);
  });

  it('treats a resumable waiting-input session parked past SESSION_STALE_MS as stale, not live', () => {
    const lastOutputAt = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    expect(isLiveInputTarget(makeSession({ status: 'waiting-input', resumable: true, lastOutputAt }), NOW)).toBe(false);
  });

  it('falls back to startedAt when lastOutputAt is absent', () => {
    const startedAt = new Date(NOW - 60_000).toISOString();
    expect(isLiveInputTarget(makeSession({ status: 'waiting-input', resumable: true, startedAt, lastOutputAt: undefined }), NOW)).toBe(true);

    const staleStartedAt = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    expect(isLiveInputTarget(makeSession({ status: 'waiting-input', resumable: true, startedAt: staleStartedAt, lastOutputAt: undefined }), NOW)).toBe(false);
  });

  it('treats a scheduled (sleeping) session as not a finish-input target', () => {
    expect(isLiveInputTarget(makeSession({ status: 'scheduled' as CliSessionSummary['status'] }), NOW)).toBe(false);
  });

  it('treats a completed session as not live', () => {
    expect(isLiveInputTarget(makeSession({ status: 'completed' }), NOW)).toBe(false);
  });
});
