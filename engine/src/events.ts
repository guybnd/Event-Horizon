import type { Response } from 'express';
import { performance } from 'node:perf_hooks';
import { incr, recordDuration } from './perf/registry.js';
import { getWorkspace, liveWorkspaces, type Workspace } from './workspace-context.js';

// FLUX-1450 (epic FLUX-1230 S5): heartbeat so idle SSE connections aren't silently reaped by OS/NAT
// idle-timeouts or laptop sleep. Without traffic the browser's EventSource keeps readyState OPEN on
// a half-open socket and never reconnects; a periodic comment-ping both keeps intermediaries from
// dropping the connection AND makes a dead socket's write fail so we prune it (writeOrDrop below).
// Comment lines (`:`-prefixed) are ignored by the EventSource parser, so the heartbeat is invisible
// to consumers. (FLUX-910 originally; renumbered here for the per-workspace fan-out rewrite.)
const KEEPALIVE_MS = 15_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * FLUX-1132: the only two places a client leaves `ws.sseClients` (a dropped write here, or the
 * 'close' handler in `addSseClient`) — routed through one function so the `sse.clients` gauge
 * decrements exactly once per client no matter which path notices it first.
 */
function removeClient(res: Response, ws: Workspace): void {
  if (ws.sseClients.delete(res)) incr('sse.clients', -1);
}

/**
 * FLUX-910: write to one client, pruning it on failure. A `res.write()` on a destroyed/half-open
 * socket throws synchronously (ERR_STREAM_DESTROYED / write-after-end); previously that threw out
 * of `broadcastEvent`'s loop and dropped the event for every client AFTER the dead one in the set
 * (and propagated into callers as a 500). Isolating + pruning here keeps a dead client from
 * poisoning broadcasts to healthy ones. Returns false if the client was dropped.
 */
function writeOrDrop(res: Response, payload: string, ws: Workspace): boolean {
  try {
    res.write(payload);
    return true;
  } catch {
    removeClient(res, ws);
    try { res.end(); } catch { /* already destroyed */ }
    return false;
  }
}

function ensureKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    // Snapshot: writeOrDrop may delete from the set mid-iteration. A NAMED `ping` event (not a bare
    // comment) so the client can OBSERVE it — its reconnect watchdog treats "no ping in ~2×interval"
    // as a stalled half-open stream and forces a reconnect (a comment fires no client-side handler).
    // FLUX-1450: one process-global timer still, now looped over every live workspace so each
    // board's clients get pinged regardless of which workspace originated the timer.
    for (const ws of liveWorkspaces()) {
      for (const res of [...ws.sseClients]) writeOrDrop(res, 'event: ping\ndata: {}\n\n', ws);
    }
  }, KEEPALIVE_MS);
  // Don't keep the process alive just for the heartbeat.
  keepaliveTimer.unref?.();
}

export function addSseClient(res: Response, ws: Workspace = getWorkspace()) {
  ws.sseClients.add(res);
  incr('sse.clients'); // FLUX-1132: connected-client gauge, decremented in removeClient()
  // Prime the stream so proxies flush headers and the client sees an immediate byte.
  writeOrDrop(res, ': connected\n\n', ws);
  res.on('close', () => removeClient(res, ws));
  ensureKeepalive();
}

// FLUX-1030 (review follow-up): high-frequency, token-level internal streams that must NOT be
// mirrored onto the generic `eh-event` channel. `assistantDelta` fires once per `text_delta` token
// (thousands per agent response) — mirroring it would (1) evict the entire 2000-cap engineEvents
// ring in the terminal within seconds, wiping the git/sync/worktree/session events the Engine-events
// log exists to surface, and (2) fire a global `appStore.patch` notify per token, reintroducing the
// whole-app re-render churn FLUX-625/626 deliberately removed. Token deltas carry no value in a
// debug log, so they emit ONLY on their named channel (the open chat node's `subscribeToEvent`
// consumer still gets them) and are never buffered. `ping` is written directly by the keepalive, not
// via broadcastEvent, so it is already excluded.
const UNMIRRORED_EVENTS = new Set(['assistantDelta']);

// FLUX-1144: monotonic counter bumped on every task mutation, so `GET /api/tasks` can serve a
// version-keyed ETag and answer unchanged polls with a bodyless 304 instead of re-serializing +
// re-transferring the whole list. Every mutation path already calls `broadcastEvent` with one of
// these three event names (task-store.ts, mcp-server.ts, the routes, …), so hooking the bump in
// here — rather than at each of those ~40 call sites — keeps it impossible to add a new mutation
// path that forgets to bump. Bumped unconditionally (even with zero SSE clients connected) so the
// version always reflects real state, not just what got observed live.
const TASK_MUTATION_EVENTS = new Set(['taskUpdated', 'taskCreated', 'taskDeleted']);

export function getTasksVersion(ws: Workspace = getWorkspace()): number {
  return ws.tasksVersion;
}

// FLUX-1338: bump the version out-of-band from a task mutation. A workspace switch replaces the
// whole task set in one shot (doActivateWorkspace) but broadcasts no per-task taskUpdated/Created/
// Deleted event, so `tasksVersion` would otherwise stay put across the switch — leaving the portal's
// cached `GET /api/tasks` ETag valid and the engine answering the first post-switch poll with a 304,
// so the board kept rendering the PREVIOUS workspace's tickets. Bumping here invalidates that cache.
export function bumpTasksVersion(ws: Workspace = getWorkspace()): void {
  ws.tasksVersion++;
}

// FLUX-1132: bounds the `sse.broadcast.<event>` counter's cardinality. Every real call site passes
// a literal (verified via grep — `taskUpdated`, `activity`, `notification`, ...); this only guards
// against a future dynamic/user-influenced event name blowing up the registry's key count.
const SAFE_EVENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function bucketEventName(event: string): string {
  return SAFE_EVENT_NAME_RE.test(event) ? event : 'other';
}

// FLUX-1450: `ws` defaults to `getWorkspace()` so the ~123 existing call sites (routed by S2/S3/S4
// to pass their actual originating workspace) keep compiling and behaving byte-for-byte the same in
// today's single-workspace mode — only callers that pass an explicit `ws` get real isolation.
export function broadcastEvent(event: string, data: unknown, ws: Workspace = getWorkspace()) {
  if (TASK_MUTATION_EVENTS.has(event)) ws.tasksVersion++;
  incr(`sse.broadcast.${bucketEventName(event)}`);
  // FLUX-1030: emit each event TWICE — once as its named SSE event (unchanged, so every existing
  // consumer that listens on a specific name keeps working), and once on a generic `eh-event`
  // channel carrying `{ type, data }`. The terminal's Engine-events log listens ONLY on `eh-event`
  // and therefore surfaces every event type — including new ones — without the client needing a
  // hardcoded allowlist that silently drops whatever isn't in it. Keep both frames in a single
  // write so a client can never observe one without the other. High-frequency token streams
  // (UNMIRRORED_EVENTS) skip the generic mirror to protect the ring buffer and avoid store churn.
  const named = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const payload = UNMIRRORED_EVENTS.has(event)
    ? named
    : named + `event: eh-event\ndata: ${JSON.stringify({ type: event, data })}\n\n`;
  // Iterate a snapshot so pruning a dead client mid-loop is safe, and so one dead socket's failed
  // write can't throw out of the loop and drop the event for every client behind it (FLUX-910).
  // FLUX-1450: fan out only to THIS workspace's clients — the isolation this ticket delivers.
  const startedAt = performance.now();
  for (const res of [...ws.sseClients]) writeOrDrop(res, payload, ws);
  recordDuration('sse.broadcastFanout', performance.now() - startedAt);
}
