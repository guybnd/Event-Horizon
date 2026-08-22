import express from 'express';
import { refreshGhAvailability, ensureGhAvailabilityFresh, detectLinuxPackageManager, getGhLastCheckedAt } from '../gh-availability.js';
import { invalidateGhAuthCache } from '../git-sync-env.js';

const router = express.Router();

// GET /api/gh/status — deliberately NOT behind requireWorkspace, same reasoning as POST
// /recheck below. Respects gh-availability.ts's freshness policy (FLUX-1686): a stale
// negative cache self-heals, a fresh positive one costs no subprocess — unlike POST
// /recheck this has NO side effect on git-sync-env.ts's separate gh cache, so opening the
// launch dialog repeatedly is free. `null` means availability was never determined; that
// maps to 503 rather than a wire value, so the portal's existing failed-fetch path lights
// up the "unknown" state instead of a fourth wire state.
router.get('/status', async (_req, res) => {
  const result = await ensureGhAvailabilityFresh();
  if (result === null) {
    res.status(503).json({ error: 'gh availability could not be determined' });
    return;
  }
  const linuxPackageManager = await detectLinuxPackageManager();
  res.json({
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    platform: process.platform,
    linuxPackageManager,
    lastCheckedAt: getGhLastCheckedAt(),
  });
});

// POST /api/gh/recheck — deliberately NOT behind requireWorkspace: the probe passes
// `env: process.env` with no `cwd`, so it is workspace-independent. Re-probes gh live
// (no restart needed) and drops git-sync-env.ts's SEPARATE 30s-TTL gh cache too, so a
// fresh `gh auth login` is picked up by background sync as well as the wizard/health.
// Unconditional — no freshness floor — so Re-check is always a real probe.
router.post('/recheck', async (_req, res) => {
  const result = await refreshGhAvailability();
  invalidateGhAuthCache();
  const linuxPackageManager = await detectLinuxPackageManager();
  res.json({
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    platform: process.platform,
    linuxPackageManager,
    lastCheckedAt: getGhLastCheckedAt(),
  });
});

export default router;
