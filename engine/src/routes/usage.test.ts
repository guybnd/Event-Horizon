import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import usageRouter from './usage.js';

describe('GET /api/usage', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use('/api/usage', usageRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 200 with no workspace header — usage is account-level, not workspace-scoped', async () => {
    const res = await fetch(`${baseUrl}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.generatedAt).toBe('string');
    expect(Array.isArray(body.providers)).toBe(true);
    const providerNames = body.providers.map((p: { provider: string }) => p.provider).sort();
    expect(providerNames).toEqual(['antigravity', 'claude', 'codex', 'copilot', 'gemini', 'grok'].sort());

    for (const provider of body.providers) {
      expect(['exact', 'floor', 'unknown']).toContain(provider.provenance);
      expect(Array.isArray(provider.gauges)).toBe(true);
      expect(Array.isArray(provider.history)).toBe(true);
    }
  });
});
