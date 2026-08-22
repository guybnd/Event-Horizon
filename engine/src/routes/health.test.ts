import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const getCachedGhAvailabilityMock = vi.fn();
vi.mock('../gh-availability.js', () => ({
  getCachedGhAvailability: getCachedGhAvailabilityMock,
}));

const getWorkspaceRootMock = vi.fn();
vi.mock('../workspace.js', () => ({
  getWorkspaceRoot: getWorkspaceRootMock,
}));

describe('GET /api/health', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    getCachedGhAvailabilityMock.mockReset();
    getWorkspaceRootMock.mockReset();
    getWorkspaceRootMock.mockReturnValue('/workspace/root');

    const { default: healthRouter } = await import('./health.js');
    const app = express();
    app.use('/api/health', healthRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports ghAuthAvailable: null before any probe', async () => {
    getCachedGhAvailabilityMock.mockReturnValue(null);
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', workspace: '/workspace/root', ghAuthAvailable: null });
  });

  it('reports ghAuthAvailable: false after a failed probe', async () => {
    getCachedGhAvailabilityMock.mockReturnValue({ ok: false, reason: 'not-authenticated' });
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    expect(body.ghAuthAvailable).toBe(false);
  });

  it('reports ghAuthAvailable: true after a successful probe (the Re-check regression)', async () => {
    getCachedGhAvailabilityMock.mockReturnValue({ ok: true });
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    expect(body.ghAuthAvailable).toBe(true);
  });
});
