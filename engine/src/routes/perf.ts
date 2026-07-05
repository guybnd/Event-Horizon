import express from 'express';
import { snapshot } from '../perf/registry.js';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json(snapshot());
});

export default router;
