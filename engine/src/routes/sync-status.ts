import express from 'express';
import { getSyncStatus, onSyncStatusChange, triggerSync, triggerTestError } from '../sync-watcher.js';

const router = express.Router();

// GET /api/sync-status - returns current sync status
router.get('/', (_req, res) => {
  res.json(getSyncStatus());
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

  // Clean up on client disconnect
  _req.on('close', () => {
    unsubscribe();
    if (!res.writableEnded) res.end();
  });
});

export default router;
