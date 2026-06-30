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

export function broadcastEvent(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // Iterate a snapshot so pruning a dead client mid-loop is safe, and so one dead socket's failed
  // write can't throw out of the loop and drop the event for every client behind it (FLUX-910).
  for (const res of [...clients]) writeOrDrop(res, payload);
}
