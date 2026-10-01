/**
 * Long-held engine self-fetches (MCP `delegate` waits on /cli-session/delegate).
 *
 * undici's default `headersTimeout`/`bodyTimeout` are 300s. The engine route will wait
 * up to 600s, so a child that runs 5–6 minutes dies on the MCP hop with TypeError
 * "fetch failed" while the child keeps running (FLUX-1735 / incident FLUX-1733). A custom Agent is required
 * — bumping only AbortSignal still loses to headersTimeout (see ask-questions.ts).
 *
 * One process-wide Agent (not per-call) so we never `close()` a dispatcher while the
 * caller is still reading the response body. Per-call AbortSignal still caps each wait.
 */
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

/** Extra margin past the engine's own wait so the client fetch is not the first to die. */
export const ENGINE_FETCH_SLACK_MS = 30_000;

/** Ceiling matching the engine delegate route max (600s) plus slack. */
export const ENGINE_FETCH_MAX_MS = 600_000 + ENGINE_FETCH_SLACK_MS;

const longFetchAgent = new Agent({
  headersTimeout: ENGINE_FETCH_MAX_MS,
  bodyTimeout: ENGINE_FETCH_MAX_MS,
  connectTimeout: 30_000,
});

export function engineFetchTimeoutMs(waitMs: number): number {
  return waitMs + ENGINE_FETCH_SLACK_MS;
}

export async function engineLongFetch(url: string, init: RequestInit, waitMs: number): Promise<Response> {
  const timeout = Math.min(engineFetchTimeoutMs(waitMs), ENGINE_FETCH_MAX_MS);
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    dispatcher: longFetchAgent,
    signal: init.signal ?? AbortSignal.timeout(timeout),
  } as UndiciRequestInit);
  return res as unknown as Response;
}
