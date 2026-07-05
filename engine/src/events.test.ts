import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Response } from 'express';
import { addSseClient, broadcastEvent } from './events.js';
import { snapshot, resetForTest } from './perf/registry.js';

/** Minimal stand-in for an Express Response an SSE route hands to addSseClient/broadcastEvent. */
function fakeClient(): { res: Response; close: () => void; writes: string[] } {
  const handlers: Record<string, () => void> = {};
  const writes: string[] = [];
  const res = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
    },
  } as unknown as Response;
  return { res, close: () => handlers.close?.(), writes };
}

describe('events perf instrumentation (FLUX-1132)', () => {
  // `clients` in events.ts is module-global state with no test reset hook — track every client
  // this suite connects and close it in afterEach so nothing leaks into the next test's broadcasts.
  let connected: ReturnType<typeof fakeClient>[];

  function connectClient() {
    const c = fakeClient();
    addSseClient(c.res);
    connected.push(c);
    return c;
  }

  beforeEach(() => {
    resetForTest();
    connected = [];
  });

  afterEach(() => {
    for (const c of connected) c.close();
    vi.restoreAllMocks();
  });

  it('increments sse.clients on connect and decrements on close', () => {
    const a = connectClient();
    connectClient();
    expect(snapshot().counters['sse.clients']).toBe(2);

    a.close();
    expect(snapshot().counters['sse.clients']).toBe(1);
  });

  it('does not double-decrement if a dead write already dropped the client before close fires', () => {
    const client = connectClient();
    // Simulate a write failure pruning the client (writeOrDrop path) ahead of 'close'.
    (client.res.write as unknown as () => void) = () => {
      throw new Error('ERR_STREAM_DESTROYED');
    };
    broadcastEvent('taskUpdated', { id: 'FLUX-1' });
    expect(snapshot().counters['sse.clients']).toBe(0);

    client.close(); // late 'close' for the same socket — must not decrement again
    expect(snapshot().counters['sse.clients']).toBe(0);
  });

  it('increments a per-event-type broadcast counter', () => {
    connectClient();
    broadcastEvent('taskUpdated', {});
    broadcastEvent('taskUpdated', {});
    broadcastEvent('activity', {});
    const { counters } = snapshot();
    expect(counters['sse.broadcast.taskUpdated']).toBe(2);
    expect(counters['sse.broadcast.activity']).toBe(1);
  });

  it('buckets a non-word-safe event name under sse.broadcast.other', () => {
    connectClient();
    broadcastEvent('weird event!', {});
    expect(snapshot().counters['sse.broadcast.other']).toBe(1);
  });

  it('records the fanout duration under sse.broadcastFanout', () => {
    connectClient();
    broadcastEvent('taskUpdated', {});
    const { histograms } = snapshot();
    expect(histograms['sse.broadcastFanout']?.count).toBe(1);
  });
});
