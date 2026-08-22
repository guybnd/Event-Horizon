import express from 'express';
import { getWorkspaceRoot } from '../workspace.js';
import { getCachedGhAvailability } from '../gh-availability.js';

const router = express.Router();

// GET /api/health — no workspace required; must answer even with no workspace active.
router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    workspace: getWorkspaceRoot(),
    ghAuthAvailable: getCachedGhAvailability()?.ok ?? null,
  });
});

export default router;
