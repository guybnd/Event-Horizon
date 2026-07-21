import { describe, it, expect, vi, beforeEach } from 'vitest';
import { watchForCredentialRefresh, stopCredentialWatch } from './auth-recovery-watch.js';

// FLUX-1601: the watch is a bounded mtime poll, not a real fs.watch — fully fake-timer-driven here so
// the test suite never actually waits 3s/15min or touches the real filesystem.
describe('watchForCredentialRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('broadcasts authRecovered the moment the credentials file mtime changes', () => {
    const broadcast = vi.fn();
    let mtime: number | undefined = 1000;
    watchForCredentialRefresh('FLUX-1', {
      statMtimeMs: () => mtime,
      broadcast,
      credentialsPath: '/fake/.credentials.json',
    });
    vi.advanceTimersByTime(3_000);
    expect(broadcast).not.toHaveBeenCalled();

    mtime = 2000; // re-login rewrote the file
    vi.advanceTimersByTime(3_000);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('authRecovered', { taskId: 'FLUX-1' });
  });

  it('treats the file appearing for the first time (undefined -> defined mtime) as a refresh too', () => {
    const broadcast = vi.fn();
    let mtime: number | undefined = undefined;
    watchForCredentialRefresh('FLUX-2', { statMtimeMs: () => mtime, broadcast });
    mtime = 500;
    vi.advanceTimersByTime(3_000);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('authRecovered', { taskId: 'FLUX-2' });
  });

  it('stops polling and never broadcasts once the bound expires with no change', () => {
    const broadcast = vi.fn();
    watchForCredentialRefresh('FLUX-3', { statMtimeMs: () => 1000, broadcast });
    vi.advanceTimersByTime(15 * 60 * 1000 + 10_000);
    expect(broadcast).not.toHaveBeenCalled();
    // The bound also tore down the poll interval — further time never fires it either.
    broadcast.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a second watch for the same taskId replaces (not stacks on) the first', () => {
    const broadcast = vi.fn();
    let mtime = 1000;
    watchForCredentialRefresh('FLUX-4', { statMtimeMs: () => mtime, broadcast });
    watchForCredentialRefresh('FLUX-4', { statMtimeMs: () => mtime, broadcast }); // replaces the first
    mtime = 2000;
    vi.advanceTimersByTime(3_000);
    // Only one broadcast — the superseded first watch's interval was cleared, not left running
    // alongside the second to double-fire.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('stopCredentialWatch cancels an active watch so it never broadcasts', () => {
    const broadcast = vi.fn();
    let mtime = 1000;
    watchForCredentialRefresh('FLUX-5', { statMtimeMs: () => mtime, broadcast });
    stopCredentialWatch('FLUX-5');
    mtime = 2000;
    vi.advanceTimersByTime(3_000);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
