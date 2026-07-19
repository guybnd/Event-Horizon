import express from 'express';
import { requireWorkspace, resolveWorkspaceFromRoot } from '../middleware.js';
import { addSseClient } from '../events.js';

const router = express.Router();

router.get('/', requireWorkspace, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // FLUX-910: defeat proxy/dev-server response buffering (e.g. nginx) so events flush immediately.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // FLUX-1450 / FLUX-1530: tag the client with the connecting board at connect time, resolved from
  // `?ws=` (not `req.workspace` — EventSource can't send headers, so the header-based binding never
  // applies here). Unset/unknown `?ws=` falls back to the registry default, same as the header path.
  const wsParam = typeof req.query.ws === 'string' ? req.query.ws : undefined;
  addSseClient(res, resolveWorkspaceFromRoot(wsParam));
});

export default router;
