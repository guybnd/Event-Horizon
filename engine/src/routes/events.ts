import express from 'express';
import { requireWorkspace } from '../middleware.js';
import { addSseClient } from '../events.js';

const router = express.Router();

router.get('/', requireWorkspace, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  addSseClient(res);
});

export default router;
