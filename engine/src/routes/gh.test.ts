import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const refreshGhAvailabilityMock = vi.fn();
const ensureGhAvailabilityFreshMock = vi.fn();
const detectLinuxPackageManagerMock = vi.fn();
const getGhLastCheckedAtMock = vi.fn();
vi.mock('../gh-availability.js', () => ({
  refreshGhAvailability: refreshGhAvailabilityMock,
  ensureGhAvailabilityFresh: ensureGhAvailabilityFreshMock,
  detectLinuxPackageManager: detectLinuxPackageManagerMock,
  getGhLastCheckedAt: getGhLastCheckedAtMock,
}));

const invalidateGhAuthCacheMock = vi.fn();
vi.mock('../git-sync-env.js', () => ({
  invalidateGhAuthCache: invalidateGhAuthCacheMock,
}));

describe('gh routes', () => {
  let server: http.Server;
  let baseUrl: string;
  const originalPlatform = process.platform;

  beforeEach(async () => {
    refreshGhAvailabilityMock.mockReset();
    ensureGhAvailabilityFreshMock.mockReset();
    detectLinuxPackageManagerMock.mockReset();
    invalidateGhAuthCacheMock.mockReset();
    getGhLastCheckedAtMock.mockReset();
    detectLinuxPackageManagerMock.mockResolvedValue(null);
    getGhLastCheckedAtMock.mockReturnValue(1_000);

    const { default: ghRouter } = await import('./gh.js');
    const app = express();
    app.use('/api/gh', ghRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /api/gh/status', () => {
    it('calls ensureGhAvailabilityFresh but not invalidateGhAuthCache', async () => {
      ensureGhAvailabilityFreshMock.mockResolvedValue({ ok: true });
      await fetch(`${baseUrl}/api/gh/status`);
      expect(ensureGhAvailabilityFreshMock).toHaveBeenCalledTimes(1);
      expect(refreshGhAvailabilityMock).not.toHaveBeenCalled();
      expect(invalidateGhAuthCacheMock).not.toHaveBeenCalled();
    });

    it('returns the full payload including lastCheckedAt on success', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      ensureGhAvailabilityFreshMock.mockResolvedValue({ ok: false, reason: 'not-authenticated' });
      detectLinuxPackageManagerMock.mockResolvedValue('apt');
      getGhLastCheckedAtMock.mockReturnValue(12_345);
      const res = await fetch(`${baseUrl}/api/gh/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ok: false,
        reason: 'not-authenticated',
        platform: 'linux',
        linuxPackageManager: 'apt',
        lastCheckedAt: 12_345,
      });
    });

    it('responds 503 when ensureGhAvailabilityFresh resolves null', async () => {
      ensureGhAvailabilityFreshMock.mockResolvedValue(null);
      const res = await fetch(`${baseUrl}/api/gh/status`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: expect.any(String) });
      expect(detectLinuxPackageManagerMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/gh/recheck', () => {
    it('calls both refreshGhAvailability and invalidateGhAuthCache (AC6\'s entire mechanism)', async () => {
      refreshGhAvailabilityMock.mockResolvedValue({ ok: true });
      await fetch(`${baseUrl}/api/gh/recheck`, { method: 'POST' });
      expect(refreshGhAvailabilityMock).toHaveBeenCalledTimes(1);
      expect(invalidateGhAuthCacheMock).toHaveBeenCalledTimes(1);
    });

    it('returns { ok: true, platform, linuxPackageManager, lastCheckedAt } on success', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      refreshGhAvailabilityMock.mockResolvedValue({ ok: true });
      getGhLastCheckedAtMock.mockReturnValue(5_000);
      const res = await fetch(`${baseUrl}/api/gh/recheck`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, platform: 'darwin', linuxPackageManager: null, lastCheckedAt: 5_000 });
    });

    it('returns { ok: false, reason, platform, linuxPackageManager, lastCheckedAt } on failure', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      refreshGhAvailabilityMock.mockResolvedValue({ ok: false, reason: 'not-authenticated' });
      detectLinuxPackageManagerMock.mockResolvedValue('apt');
      getGhLastCheckedAtMock.mockReturnValue(6_000);
      const res = await fetch(`${baseUrl}/api/gh/recheck`, { method: 'POST' });
      const body = await res.json();
      expect(body).toEqual({ ok: false, reason: 'not-authenticated', platform: 'linux', linuxPackageManager: 'apt', lastCheckedAt: 6_000 });
    });
  });
});
