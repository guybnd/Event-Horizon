import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';

/**
 * FLUX-1772 review Major 1: `waitForSessionLiveness` (mcp-session-liveness.test.ts) is well covered
 * as a pure leaf, but nothing drove the `start_session` handler's glue around it — the `session.id
 * === sid` match against the poll response, the non-ok fetch branch, and the error-text assembly
 * with `formatAuthDiagnosisMessage`. These tests exercise that handler through the real MCP
 * request/response path (`buildMcpServer` + an in-memory client, mirroring the `mcp-last-reviewed-
 * commit.test.ts` idiom), stubbing `global.fetch` for the two REST hops the handler makes
 * (`POST .../cli-session/start`, `GET .../cli-sessions`) and fake timers so the probe's up-to-5s
 * poll window costs no real wall-clock time.
 */
describe('start_session liveness handler glue (FLUX-1772)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    server = buildMcpServer();
    client = new Client({ name: 'eh-start-session-liveness-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(pollSessions: () => { id: string; status?: string; lastOutputAt?: string; terminalReason?: string }[]) {
    fetchMock = vi.fn(async (url: unknown) => {
      const s = String(url);
      if (s.includes('/cli-session/start')) {
        return { ok: true, json: async () => ({ session: { id: 'sess-live' } }) };
      }
      if (s.includes('/cli-sessions')) {
        return { ok: true, json: async () => ({ sessions: pollSessions() }) };
      }
      throw new Error(`unexpected fetch: ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  async function callStartSession(): Promise<CallToolResult> {
    const resultPromise = client.callTool({ name: 'start_session', arguments: { ticketId: 'FLUX-1' } });
    // Drain the probe's ~500ms-interval poll loop up to its 5s deadline without real wall-clock time.
    await vi.advanceTimersByTimeAsync(5000);
    return (await resultPromise) as unknown as CallToolResult;
  }

  it('returns an error result naming the reason when the dispatched session fails (sid match)', async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      if (call < 3) return [{ id: 'sess-live', status: 'running', lastOutputAt: '2026-01-01T00:00:00.000Z' }];
      return [{ id: 'sess-live', status: 'failed', terminalReason: 'auth-expired' }];
    });

    const res = await callStartSession();

    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('auth-expired');
    expect(text).toContain('FLUX-1');
  });

  it('reports liveness confirmed when the session stays healthy through the full probe window', async () => {
    stubFetch(() => [{ id: 'sess-live', status: 'running', lastOutputAt: '2026-01-01T00:00:00.000Z' }]);

    const res = await callStartSession();

    expect(res.isError).toBeFalsy();
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('liveness confirmed');
  });

  it('reports liveness unconfirmed (not an error) when the poll never sees the dispatched sid', async () => {
    // Minor 1 regression guard: an older, still-active session on the same ticket must not shadow
    // the just-dispatched one — the handler selects by `sid`, so a poll response containing only
    // the older session's id should behave the same as never seeing the session at all.
    stubFetch(() => [{ id: 'sess-old-and-unrelated', status: 'running', lastOutputAt: '2026-01-01T00:00:00.000Z' }]);

    const res = await callStartSession();

    expect(res.isError).toBeFalsy();
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('liveness unconfirmed');
  });

  it('polls the lite endpoint (FLUX-1772 review Major 2: no untruncated liveOutput on every poll)', async () => {
    stubFetch(() => [{ id: 'sess-live', status: 'running', lastOutputAt: '2026-01-01T00:00:00.000Z' }]);

    await callStartSession();

    const pollUrls = fetchMock.mock.calls.map((call: unknown[]) => String(call[0])).filter((u: string) => u.includes('/cli-sessions'));
    expect(pollUrls.length).toBeGreaterThan(0);
    for (const url of pollUrls) expect(url).toContain('lite=1');
  });

  it('returns an error immediately, with no polling, when the dispatch POST itself fails', async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      const s = String(url);
      if (s.includes('/cli-session/start')) {
        return { ok: false, statusText: 'Internal Server Error', json: async () => ({ error: 'no slots' }) };
      }
      throw new Error(`unexpected fetch: ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await client.callTool({ name: 'start_session', arguments: { ticketId: 'FLUX-1' } }) as unknown as CallToolResult;

    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('no slots');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
