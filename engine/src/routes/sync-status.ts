import express from 'express';
import { getSyncStatus, onSyncStatusChange } from '../sync-watcher.js';

const router = express.Router();

// GET /api/sync-status - returns current sync status
router.get('/', (_req, res) => {
  res.json(getSyncStatus());
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
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  });

  // Clean up on client disconnect
  _req.on('close', () => {
    unsubscribe();
    res.end();
  });
});

export default router;
