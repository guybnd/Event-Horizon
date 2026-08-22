import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getGhAvailabilityMock = vi.fn();
vi.mock('./branch-manager.js', () => ({
  getGhAvailability: getGhAvailabilityMock,
}));

const execFileMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

describe('gh-availability', () => {
  let mod: typeof import('./gh-availability.js');
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.resetModules();
    getGhAvailabilityMock.mockReset();
    execFileMock.mockReset();
    mod = await import('./gh-availability.js');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.useRealTimers();
  });

  describe('cache', () => {
    it('is null before any probe', () => {
      expect(mod.getCachedGhAvailability()).toBeNull();
      expect(mod.isGhAvailable()).toBe(false);
    });

    it('refreshGhAvailability stores and returns { ok: true }', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: true });
      const result = await mod.refreshGhAvailability();
      expect(result).toEqual({ ok: true });
      expect(mod.getCachedGhAvailability()).toEqual({ ok: true });
    });

    it('refreshGhAvailability stores and returns { ok: false, reason: "not-found" }', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: false, reason: 'not-found' });
      const result = await mod.refreshGhAvailability();
      expect(result).toEqual({ ok: false, reason: 'not-found' });
      expect(mod.getCachedGhAvailability()).toEqual({ ok: false, reason: 'not-found' });
    });

    it('refreshGhAvailability stores and returns { ok: false, reason: "not-authenticated" }', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: false, reason: 'not-authenticated' });
      const result = await mod.refreshGhAvailability();
      expect(result).toEqual({ ok: false, reason: 'not-authenticated' });
      expect(mod.getCachedGhAvailability()).toEqual({ ok: false, reason: 'not-authenticated' });
    });

    it('isGhAvailable flips false -> true across a refresh (the Re-check regression)', async () => {
      expect(mod.isGhAvailable()).toBe(false);
      getGhAvailabilityMock.mockResolvedValue({ ok: true });
      await mod.refreshGhAvailability();
      expect(mod.isGhAvailable()).toBe(true);
    });

    it('dedupes concurrent refreshGhAvailability calls onto a single underlying probe', async () => {
      let resolveProbe!: (value: { ok: true }) => void;
      getGhAvailabilityMock.mockImplementation(
        () => new Promise((resolve) => { resolveProbe = resolve; }),
      );

      const first = mod.refreshGhAvailability();
      const second = mod.refreshGhAvailability();
      resolveProbe({ ok: true });
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({ ok: true });
      expect(secondResult).toEqual({ ok: true });
      expect(getGhAvailabilityMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureGhAvailabilityFresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('probes when the cache is null', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: true });
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toEqual({ ok: true });
      expect(getGhAvailabilityMock).toHaveBeenCalledTimes(1);
    });

    it('skips a re-probe of a negative cache within the 30s floor (the boot double-probe regression)', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: false, reason: 'not-authenticated' });
      await mod.refreshGhAvailability();
      getGhAvailabilityMock.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toEqual({ ok: false, reason: 'not-authenticated' });
      expect(getGhAvailabilityMock).not.toHaveBeenCalled();
    });

    it('re-probes a negative cache once past the 30s floor (the self-heal)', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: false, reason: 'not-authenticated' });
      await mod.refreshGhAvailability();
      getGhAvailabilityMock.mockClear();

      await vi.advanceTimersByTimeAsync(30_001);
      getGhAvailabilityMock.mockResolvedValue({ ok: true });
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toEqual({ ok: true });
      expect(getGhAvailabilityMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-probe a fresh positive cache', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: true });
      await mod.refreshGhAvailability();
      getGhAvailabilityMock.mockClear();

      // Past the 30s floor, well under the 15min positive TTL.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toEqual({ ok: true });
      expect(getGhAvailabilityMock).not.toHaveBeenCalled();
    });

    it('re-probes a positive cache once the 15min positive TTL elapses', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: true });
      await mod.refreshGhAvailability();
      getGhAvailabilityMock.mockClear();

      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toEqual({ ok: true });
      expect(getGhAvailabilityMock).toHaveBeenCalledTimes(1);
    });

    it('returns the cached result rather than throwing when a re-probe rejects', async () => {
      getGhAvailabilityMock.mockResolvedValue({ ok: false, reason: 'not-authenticated' });
      await mod.refreshGhAvailability();
      getGhAvailabilityMock.mockClear();

      await vi.advanceTimersByTimeAsync(30_001);
      getGhAvailabilityMock.mockRejectedValue(new Error('boom'));
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toEqual({ ok: false, reason: 'not-authenticated' });
    });

    it('resolves null when the very first probe rejects with no prior cache', async () => {
      getGhAvailabilityMock.mockRejectedValue(new Error('boom'));
      const result = await mod.ensureGhAvailabilityFresh();
      expect(result).toBeNull();
    });
  });

  describe('detectLinuxPackageManager', () => {
    function mockWhich(available: string[]) {
      execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: (err: unknown, result?: unknown) => void) => {
        const bin = args[0] ?? '';
        if (available.includes(bin)) callback(null, { stdout: `/usr/bin/${bin}`, stderr: '' });
        else callback(Object.assign(new Error('not found'), { code: 1 }));
      });
    }

    it('returns null immediately off Linux, without probing', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockWhich(['apt']);
      const result = await mod.detectLinuxPackageManager();
      expect(result).toBeNull();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns the first candidate that resolves, in fixed order pacman > apt > dnf > zypper', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockWhich(['apt', 'dnf']);
      const result = await mod.detectLinuxPackageManager();
      expect(result).toBe('apt');
    });

    it('returns pacman when it resolves, even if a later candidate would too', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockWhich(['pacman', 'apt']);
      const result = await mod.detectLinuxPackageManager();
      expect(result).toBe('pacman');
    });

    it('returns null when none of the four resolve', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockWhich([]);
      const result = await mod.detectLinuxPackageManager();
      expect(result).toBeNull();
      expect(execFileMock).toHaveBeenCalledTimes(4);
    });

    it('memoizes per process — a second call does not re-probe', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockWhich(['dnf']);
      const first = await mod.detectLinuxPackageManager();
      const callsAfterFirst = execFileMock.mock.calls.length;
      const second = await mod.detectLinuxPackageManager();
      expect(first).toBe('dnf');
      expect(second).toBe('dnf');
      expect(execFileMock.mock.calls.length).toBe(callsAfterFirst);
    });
  });
});
