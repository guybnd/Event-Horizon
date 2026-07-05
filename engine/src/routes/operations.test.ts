import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import operationsRouter from './operations.js';
import { emitOperationEvent, type OperationEvent } from '../operation-telemetry.js';

async function fetchOperations(url: string): Promise<{ operations: OperationEvent[] }> {
  const res = await fetch(url);
  return res.json() as Promise<{ operations: OperationEvent[] }>;
}

describe('GET /api/operations', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use('/api/operations', operationsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns an empty array when nothing matches — never an error', async () => {
    const res = await fetch(`${baseUrl}/api/operations?ticketId=${encodeURIComponent(`nope-${Date.now()}`)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ operations: [] });
  });

  it('honors ticketId/sessionId/kind/outcome/limit query params, newest-first', async () => {
    const ticketId = `route-${Date.now()}-${Math.random()}`;
    emitOperationEvent({ kind: 'git', ticketId, sessionId: 's1', cmd: 'git status', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    emitOperationEvent({ kind: 'spawn', ticketId, sessionId: 's2', cmd: 'claude (spawn)', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'error' });

    const all = await fetchOperations(`${baseUrl}/api/operations?ticketId=${encodeURIComponent(ticketId)}`);
    expect(all.operations.map((o) => o.kind)).toEqual(['spawn', 'git']);

    const bySession = await fetchOperations(`${baseUrl}/api/operations?sessionId=s1&ticketId=${encodeURIComponent(ticketId)}`);
    expect(bySession.operations.map((o) => o.cmd)).toEqual(['git status']);

    const byKind = await fetchOperations(`${baseUrl}/api/operations?kind=spawn&ticketId=${encodeURIComponent(ticketId)}`);
    expect(byKind.operations.map((o) => o.cmd)).toEqual(['claude (spawn)']);

    const byOutcome = await fetchOperations(`${baseUrl}/api/operations?outcome=error&ticketId=${encodeURIComponent(ticketId)}`);
    expect(byOutcome.operations.map((o) => o.cmd)).toEqual(['claude (spawn)']);

    const limited = await fetchOperations(`${baseUrl}/api/operations?limit=1&ticketId=${encodeURIComponent(ticketId)}`);
    expect(limited.operations).toHaveLength(1);
  });

  it('ignores an invalid kind/outcome value instead of erroring', async () => {
    const ticketId = `route-invalid-${Date.now()}`;
    emitOperationEvent({ kind: 'git', ticketId, cmd: 'git status', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });

    const res = await fetch(`${baseUrl}/api/operations?kind=not-a-kind&ticketId=${encodeURIComponent(ticketId)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operations: OperationEvent[] };
    // Invalid kind is treated as "no filter" rather than throwing or silently matching nothing.
    expect(body.operations.map((o) => o.cmd)).toEqual(['git status']);
  });
});
