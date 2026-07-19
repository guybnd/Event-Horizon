import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTasks, fetchHealth, fetchWorkspaces, addWorkspace, setActiveBoardKey } from './api';

/**
 * S9 (epic FLUX-1230): `ehFetch` must thread the active board key onto every board-scoped
 * request as `X-EH-Workspace`. FLUX-1557: `fetchHealth`/`fetchWorkspaces` are reads whose
 * `workspace`/`active` fields should reflect the VIEWED board, so they go through `ehFetch` too —
 * only the workspace-registry *mutation* endpoints (add/remove/switch/open/close) still bypass it,
 * see the `ehFetch` doc comment in api.ts.
 */
describe('ehFetch board-key header (via exported call sites)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // A fresh Response per call — bodies are single-use streams, and some tests below call more
    // than one fetch-backed function against the same mock.
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setActiveBoardKey(null);
  });

  it('sends no X-EH-Workspace header before a board key is set', async () => {
    await fetchTasks();
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('X-EH-Workspace')).toBeNull();
  });

  it('board-scoped requests (fetchTasks) carry the active board key', async () => {
    setActiveBoardKey('/repo/board-a');
    await fetchTasks();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('X-EH-Workspace')).toBe('/repo/board-a');
    expect(url).toBe('/api/tasks');
  });

  it('fetchHealth/fetchWorkspaces (FLUX-1557) carry the viewed board key when set, and send no header before boot resolves one', async () => {
    await fetchHealth();
    const [healthUrl, healthInitNoKey] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(healthInitNoKey?.headers).get('X-EH-Workspace')).toBeNull();
    expect(healthUrl).toBe('/api/health');

    setActiveBoardKey('/repo/board-a');
    await fetchHealth();
    const [, healthInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(new Headers(healthInit?.headers).get('X-EH-Workspace')).toBe('/repo/board-a');

    await fetchWorkspaces();
    const [wsUrl, wsInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(new Headers(wsInit?.headers).get('X-EH-Workspace')).toBe('/repo/board-a');
    expect(wsUrl).toBe('/api/workspaces');
  });

  it('registry mutation endpoints (addWorkspace) still bypass the board key', async () => {
    setActiveBoardKey('/repo/board-a');
    await addWorkspace('/repo/board-b');
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('X-EH-Workspace')).toBeNull();
  });
});
