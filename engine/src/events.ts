import type { Response } from 'express';

const clients = new Set<Response>();

// FLUX-910: heartbeat so idle SSE connections aren't silently reaped by OS/NAT idle-timeouts or
// laptop sleep. Without traffic the browser's EventSource keeps readyState OPEN on a half-open
// socket and never reconnects; a periodic comment-ping both keeps intermediaries from dropping the
// connection AND makes a dead socket's write fail so we prune it (writeOrDrop below). Comment lines
// (`:`-prefixed) are ignored by the EventSource parser, so the heartbeat is invisible to consumers.
const KEEPALIVE_MS = 15_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * FLUX-910: write to one client, pruning it on failure. A `res.write()` on a destroyed/half-open
 * socket throws synchronously (ERR_STREAM_DESTROYED / write-after-end); previously that threw out
 * of `broadcastEvent`'s loop and dropped the event for every client AFTER the dead one in the set
 * (and propagated into callers as a 500). Isolating + pruning here keeps a dead client from
 * poisoning broadcasts to healthy ones. Returns false if the client was dropped.
 */
function writeOrDrop(res: Response, payload: string): boolean {
  try {
    res.write(payload);
    return true;
  } catch {
    clients.delete(res);
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
    for (const res of [...clients]) writeOrDrop(res, 'event: ping\ndata: {}\n\n');
  }, KEEPALIVE_MS);
  // Don't keep the process alive just for the heartbeat.
  keepaliveTimer.unref?.();
}

export function addSseClient(res: Response) {
  clients.add(res);
  // Prime the stream so proxies flush headers and the client sees an immediate byte.
  writeOrDrop(res, ': connected\n\n');
  res.on('close', () => clients.delete(res));
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

export function broadcastEvent(event: string, data: unknown) {
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
  for (const res of [...clients]) writeOrDrop(res, payload);
}
