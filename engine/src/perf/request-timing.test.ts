import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { requestTiming } from './request-timing.js';
import { snapshot, resetForTest } from './registry.js';
import { log } from '../log.js';

async function buildApp(): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(requestTiming);
  app.get('/api/tasks/:id', (_req, res) => res.json({ ok: true }));
  // No route registered for /api/widgets/* — a request there 404s with req.route
  // left unset, exercising the normalizePath() id-collapsing fallback.
  app.get('/slow', async (_req, res) => {
    const ms = Number(process.env.EH_PERF_SLOW_REQ_MS ?? '200') + 20;
    await new Promise((resolve) => setTimeout(resolve, ms));
    res.json({ ok: true });
  });
  app.get('/fast', (_req, res) => res.json({ ok: true }));
  app.get('/api/events', (_req, res) => res.json({ ok: true }));
  app.get('/api/sync-status/stream', (_req, res) => res.json({ ok: true }));
  // Array-registered route — req.route.path is a string[] here, not a string.
  app.get(['/api/multi/a', '/api/multi/b'], (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('requestTiming middleware', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetForTest();
    delete process.env.EH_PERF_SLOW_REQ_MS;
    ({ server, baseUrl } = await buildApp());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('records a duration under the matched Express route pattern', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/FLUX-123`);
    expect(res.status).toBe(200);
    const h = snapshot().histograms['http.GET /api/tasks/:id'];
    expect(h).toBeDefined();
    expect(h!.count).toBe(1);
  });

  it('normalizes an id-shaped path segment when no Express route matches', async () => {
    const res = await fetch(`${baseUrl}/api/widgets/FLUX-42`);
    expect(res.status).toBe(404);
    const h = snapshot().histograms['http.GET /api/widgets/:id'];
    expect(h).toBeDefined();
    expect(h!.count).toBe(1);
  });

  it('sets a Server-Timing response header', async () => {
    const res = await fetch(`${baseUrl}/fast`);
    const header = res.headers.get('server-timing');
    expect(header).toMatch(/^app;dur=\d+(\.\d+)?$/);
  });

  it('logs a warning when a request exceeds the slow-request threshold', async () => {
    process.env.EH_PERF_SLOW_REQ_MS = '5';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await fetch(`${baseUrl}/slow`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/slow request/i);
  });

  it('does not log a warning for a fast request', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await fetch(`${baseUrl}/fast`);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to normalizePath() when req.route.path is not a string (array-registered route)', async () => {
    const res = await fetch(`${baseUrl}/api/multi/a`);
    expect(res.status).toBe(200);
    const h = snapshot().histograms['http.GET /api/multi/a'];
    expect(h).toBeDefined();
    expect(h!.count).toBe(1);
    expect(Object.keys(snapshot().histograms).some((k) => k.includes('[object'))).toBe(false);
  });

  it('excludes SSE routes from timing and slow-request logging', async () => {
    process.env.EH_PERF_SLOW_REQ_MS = '1';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await fetch(`${baseUrl}/api/events`);
    await fetch(`${baseUrl}/api/sync-status/stream`);
    const { histograms } = snapshot();
    expect(Object.keys(histograms).some((k) => k.includes('/api/events'))).toBe(false);
    expect(Object.keys(histograms).some((k) => k.includes('/api/sync-status/stream'))).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
