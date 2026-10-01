import express from 'express';
import { getUsageSnapshot } from '../usage/usage-store.js';

const router = express.Router();

router.get('/', (_req, res) => {
  try {
    res.json(getUsageSnapshot());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'usage snapshot failed' });
  }
});

export default router;
