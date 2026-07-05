import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import perfRouter from './perf.js';
import { incr, recordDuration, resetForTest } from '../perf/registry.js';

describe('GET /api/perf', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetForTest();
    const app = express();
    app.use('/api/perf', perfRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns the registry snapshot shape', async () => {
    incr('some.counter');
    recordDuration('http.GET /api/tasks/:id', 12);

    const res = await fetch(`${baseUrl}/api/perf`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counters['some.counter']).toBe(1);
    expect(body.histograms['http.GET /api/tasks/:id'].count).toBe(1);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.rss).toBe('number');
  });

  it('returns an empty-but-valid snapshot when nothing has been recorded', async () => {
    const res = await fetch(`${baseUrl}/api/perf`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counters).toEqual({});
    expect(body.histograms).toEqual({});
  });
});
