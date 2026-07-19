import { describe, it, expect } from 'vitest';
import { isSessionStale, SESSION_STALE_MS } from './orchestration';
import type { CliSessionSummary } from './types';

const NOW = new Date('2026-07-18T05:00:00.000Z').getTime();

function makeSession(overrides: Partial<CliSessionSummary> = {}): Pick<CliSessionSummary, 'status' | 'lastOutputAt' | 'startedAt' | 'resumable'> {
  return {
    status: 'running',
    startedAt: '2026-07-18T04:55:00.000Z',
    ...overrides,
  };
}

describe('isSessionStale (FLUX-1532)', () => {
  it('is not stale when the last output is recent', () => {
    const lastOutputAt = new Date(NOW - 60_000).toISOString();
    expect(isSessionStale(makeSession({ status: 'running', lastOutputAt }), NOW)).toBe(false);
  });

  it('is stale once the last output crosses SESSION_STALE_MS', () => {
    const lastOutputAt = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    expect(isSessionStale(makeSession({ status: 'running', lastOutputAt }), NOW)).toBe(true);
  });

  it('falls back to startedAt when lastOutputAt is absent', () => {
    const staleStartedAt = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    expect(isSessionStale(makeSession({ status: 'pending', startedAt: staleStartedAt, lastOutputAt: undefined }), NOW)).toBe(true);

    const recentStartedAt = new Date(NOW - 60_000).toISOString();
    expect(isSessionStale(makeSession({ status: 'pending', startedAt: recentStartedAt, lastOutputAt: undefined }), NOW)).toBe(false);
  });

  it('treats a non-resumable waiting-input session as stale regardless of output age', () => {
    const recentLastOutput = new Date(NOW - 1_000).toISOString();
    expect(
      isSessionStale(makeSession({ status: 'waiting-input', resumable: false, lastOutputAt: recentLastOutput }), NOW),
    ).toBe(true);
  });

  it('treats a resumable waiting-input session with recent output as not stale', () => {
    const recentLastOutput = new Date(NOW - 60_000).toISOString();
    expect(
      isSessionStale(makeSession({ status: 'waiting-input', resumable: true, lastOutputAt: recentLastOutput }), NOW),
    ).toBe(false);
  });

  it('treats a resumable waiting-input session past SESSION_STALE_MS as stale', () => {
    const staleLastOutput = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    expect(
      isSessionStale(makeSession({ status: 'waiting-input', resumable: true, lastOutputAt: staleLastOutput }), NOW),
    ).toBe(true);
  });

  it('never treats a scheduled (sleeping) session as stale, even with a very old lastOutputAt (FLUX-1390)', () => {
    const veryOldLastOutput = new Date(NOW - SESSION_STALE_MS * 10).toISOString();
    expect(
      isSessionStale(makeSession({ status: 'scheduled' as CliSessionSummary['status'], lastOutputAt: veryOldLastOutput }), NOW),
    ).toBe(false);
  });

  it('defaults nowMs to the current time when omitted', () => {
    const recentLastOutput = new Date(Date.now() - 1_000).toISOString();
    expect(isSessionStale(makeSession({ status: 'running', lastOutputAt: recentLastOutput }))).toBe(false);
  });
});
