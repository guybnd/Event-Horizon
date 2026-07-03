import express from 'express';
import { getSyncStatus, onSyncStatusChange, revalidateConflictState, triggerSync, triggerTestError } from '../sync-watcher.js';

const router = express.Router();

// GET /api/sync-status - returns current sync status. Re-validates a standing conflict
// against the live worktree first (FLUX-989), so a conflict fixed out-of-band is dropped
// here rather than reported until the engine restarts. revalidateConflictState() also
// pushes any change through onSyncStatusChange, so SSE subscribers see the correction too.
router.get('/', async (_req, res) => {
  res.json(await revalidateConflictState());
});

// POST /api/sync-status/sync - trigger an immediate sync
router.post('/sync', (_req, res) => {
  triggerSync();
  res.json({ ok: true });
});

// POST /api/sync-status/test-error - trigger a test error for UI testing (dev only)
router.post('/test-error', (_req, res) => {
  triggerTestError();
  res.json({ ok: true, message: 'Test error triggered' });
});

// FLUX-995: same heartbeat interval as events.ts's KEEPALIVE_MS.
const SYNC_STATUS_KEEPALIVE_MS = 15_000;

// GET /api/sync-status/stream - SSE endpoint for real-time status updates
router.get('/stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send current status immediately
  res.write(`data: ${JSON.stringify(getSyncStatus())}\n\n`);

  // Subscribe to status changes
  const unsubscribe = onSyncStatusChange((status) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    } catch (err) {
      console.error('[sync-status] Failed to write SSE update:', err);
      unsubscribe();
    }
  });

  // FLUX-995: this stream only wrote on an actual status change, so it could sit
  // completely silent for hours while idle — exactly the "half-open socket, EventSource
  // readyState stays OPEN forever" scenario events.ts documents (FLUX-910). A periodic
  // named `ping` (ignored by the default EventSource message handler, but observable via
  // addEventListener so the client watchdog can use it) keeps intermediaries from reaping
  // the connection and gives the client a liveness signal to force a reconnect on.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write('event: ping\ndata: {}\n\n');
    } catch (err) {
      console.error('[sync-status] Failed to write SSE heartbeat:', err);
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, SYNC_STATUS_KEEPALIVE_MS);
  heartbeat.unref?.();

  // Clean up on client disconnect
  _req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  });
});

export default router;
