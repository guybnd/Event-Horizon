import express from 'express';
import { listSelectablePersonaMeta } from '../orchestration-personas.js';

const router = express.Router();

// GET all user-selectable orchestration personas (metadata only — no prompt text).
router.get('/personas', (_req, res) => {
  res.json({ personas: listSelectablePersonaMeta() });
});

export default router;
