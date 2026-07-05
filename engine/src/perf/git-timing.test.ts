// Hermetic: stub the credential-env builder so the wiring tests below never spawn a real
// `gh auth status` — same setup as git-exec.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../git-sync-env.js', () => ({
  GIT_SYNC_TIMEOUT_MS: 60_000,
  buildGitSyncEnv: vi.fn(async () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })),
}));

import { startGitTiming, stopGitTiming, handleGitOperationEvent } from './git-timing.js';
import { snapshot, resetForTest } from './registry.js';
import { log } from '../log.js';
import { runHardened, type GitOperationEvent } from '../git-exec.js';

const NODE = process.execPath as unknown as 'git';

function fakeEvent(overrides: Partial<GitOperationEvent> = {}): GitOperationEvent {
  return {
    file: 'git',
    args: ['status', '--short'],
    startedAt: Date.now(),
    durationMs: 10,
    outcome: 'ok',
    ...overrides,
  };
}

describe('git timing', () => {
  beforeEach(() => {
    resetForTest();
    delete process.env.EH_PERF_SLOW_GIT_MS;
  });

  afterEach(() => {
    stopGitTiming();
    vi.restoreAllMocks();
  });

  describe('handleGitOperationEvent', () => {
    it('records the duration under git.<verb>', () => {
      handleGitOperationEvent(fakeEvent({ file: 'git', args: ['status', '--short'], durationMs: 42 }));
      const { histograms } = snapshot();
      expect(histograms['git.status']?.count).toBe(1);
      expect(histograms['git.status']?.max).toBe(42);
    });

    it('records gh calls under gh.<verb> using the first non-flag arg', () => {
      handleGitOperationEvent(fakeEvent({ file: 'gh', args: ['pr', 'view', '123'], durationMs: 5 }));
      expect(snapshot().histograms['gh.pr']?.count).toBe(1);
    });

    it('falls back to "unknown" when every arg is a flag', () => {
      handleGitOperationEvent(fakeEvent({ args: ['--version'] }));
      expect(snapshot().histograms['git.unknown']?.count).toBe(1);
    });

    it('accumulates multiple calls to the same verb', () => {
      handleGitOperationEvent(fakeEvent({ args: ['fetch'], durationMs: 10 }));
      handleGitOperationEvent(fakeEvent({ args: ['fetch'], durationMs: 20 }));
      expect(snapshot().histograms['git.fetch']?.count).toBe(2);
    });

    it('warns when a call exceeds the slow threshold (default 2000ms)', () => {
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      handleGitOperationEvent(fakeEvent({ file: 'git', args: ['fetch'], durationMs: 2500 }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/slow git/i);
      expect(warnSpy.mock.calls[0]![0]).toContain('git fetch');
    });

    it('does not warn under the threshold', () => {
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      handleGitOperationEvent(fakeEvent({ durationMs: 100 }));
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('respects the EH_PERF_SLOW_GIT_MS override', () => {
      process.env.EH_PERF_SLOW_GIT_MS = '50';
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      handleGitOperationEvent(fakeEvent({ durationMs: 100 }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('redacts a credential-embedded URL echoed in an arg (defense in depth)', () => {
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      handleGitOperationEvent(
        fakeEvent({
          file: 'git',
          args: ['fetch', 'https://x-access-token:SECRET123@github.com/org/repo.git'],
          durationMs: 3000,
        }),
      );
      expect(warnSpy.mock.calls[0]![0]).not.toContain('SECRET123');
    });
  });

  describe('startGitTiming wiring', () => {
    it('records a real runHardened() call into the registry via the git-exec sink', async () => {
      startGitTiming();
      await runHardened(NODE, ['-e', ''], { timeoutMs: 5_000 });
      // NODE stands in for 'git' (see git-exec.test.ts), so at runtime `file` is really the
      // node.exe path with no flags — verbOf() picks the whole path as the "verb". Assert via
      // total histogram count instead of a specific key name.
      const total = Object.values(snapshot().histograms).reduce((sum, h) => sum + h.count, 0);
      expect(total).toBe(1);
    });

    it('is idempotent — a second start() call does not double-register the sink', async () => {
      startGitTiming();
      startGitTiming();
      await runHardened(NODE, ['-e', ''], { timeoutMs: 5_000 });
      const total = Object.values(snapshot().histograms).reduce((sum, h) => sum + h.count, 0);
      expect(total).toBe(1);
    });
  });
});
