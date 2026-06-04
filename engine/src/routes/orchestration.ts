import express from 'express';
import { listSelectablePersonaMeta } from '../orchestration-personas.js';
import type { Phase } from '../models/workflow.js';

const router = express.Router();

const VALID_PHASES: Phase[] = ['grooming', 'implementation', 'review', 'release'];

// GET all user-selectable orchestration personas (metadata only — no prompt text).
// Optional `?phase=` filters to personas configured for that ticket phase.
router.get('/personas', (req, res) => {
  const phaseRaw = typeof req.query.phase === 'string' ? req.query.phase.trim() : '';
  const phase = (VALID_PHASES as string[]).includes(phaseRaw)
    ? (phaseRaw as Phase)
    : undefined;
  res.json({ personas: listSelectablePersonaMeta(phase) });
});

export default router;
