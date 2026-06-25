import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { resolveSkillSourceRoot } from '../workspace.js';
import { isPathInsideRoot } from '../file-utils.js';
import { isPackaged } from '../packaged-mode.js';

// ─── Dev-only onboarding-features editor endpoints (FLUX-755) ──────────────────
//
// Reads/writes the SINGLE committed onboarding config that drives the wizard's
// "What you can do" step (portal/src/config/onboardingFeatures.json), so a hidden
// /dev/onboarding editor can preview + persist panel edits with a clean git diff.
//
// This router is dev-only on TWO independent layers:
//   1. index.ts mounts it ONLY when DEV (see below) — never in a packaged build.
//   2. Each handler re-checks DEV and 404s as a backstop against an accidental mount.
//
// It is mounted WITHOUT requireWorkspace on purpose: the config file lives in the
// EH SOURCE tree (repo-relative), not in the active workspace, so requireWorkspace
// would resolve the wrong root.

const router = express.Router();

/**
 * DEV gate (Node has no import.meta.env.DEV). isPackaged is true in pkg/SEA/electron
 * production binaries and false under tsx dev, so the router never serves when shipped.
 */
const DEV = !isPackaged && process.env.NODE_ENV !== 'production';

// The target file is computed ONCE, server-side, with NO value interpolated from
// the request — there is no path param and no filename in the body, so path
// traversal is structurally impossible. The guards below are belt-and-suspenders.
const CONFIG_DIR = path.join(resolveSkillSourceRoot(), 'portal', 'src', 'config');
const PANELS_FILE = path.join(CONFIG_DIR, 'onboardingFeatures.json');
const PANELS_BASENAME = 'onboardingFeatures.json';

/**
 * Defense-in-depth: assert the resolved target is exactly the expected file inside
 * the expected dir before any read/write. Returns false → caller responds 403.
 */
function isTargetSafe(): boolean {
  return (
    path.basename(PANELS_FILE) === PANELS_BASENAME &&
    isPathInsideRoot(CONFIG_DIR, PANELS_FILE)
  );
}

interface FeaturePanel {
  id: string;
  icon: string;
  title: string;
  desc: string;
}

interface OnboardingFeaturesConfig {
  version: number;
  features: FeaturePanel[];
}

/**
 * Strict PUT body-shape validation — reject (400, write nothing) anything that is
 * not { version: number, features: Array<{ id, icon, title, desc: string }> }.
 * Guards the committed file so a malformed save can never brick the wizard import.
 */
function validateConfigBody(body: unknown): body is OnboardingFeaturesConfig {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.version !== 'number' || !Number.isFinite(candidate.version)) return false;
  if (!Array.isArray(candidate.features)) return false;
  return candidate.features.every((entry) => {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.icon === 'string' &&
      typeof item.title === 'string' &&
      typeof item.desc === 'string'
    );
  });
}

/** GET the parsed onboarding config ({ version, features }). 404 on ENOENT. */
router.get('/onboarding-features', async (_req, res) => {
  if (!DEV) return res.status(404).end();
  if (!isTargetSafe()) return res.status(403).json({ error: 'Refusing to read outside the config dir' });

  try {
    const text = await fs.readFile(PANELS_FILE, 'utf-8');
    return res.json(JSON.parse(text));
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return res.status(404).json({ error: 'Onboarding features config not found' });
    }
    console.error('[dev-onboarding] read failed:', err);
    return res.status(500).json({ error: 'Failed to read onboarding features config' });
  }
});

/**
 * PUT the onboarding config — RETIRED (FLUX-763 Phase 4).
 *
 * This used to be the Studio Features-tab Save target, writing the COMMITTED
 * onboardingFeatures.json directly — which dirtied a tracked file on every save and
 * blocked `git pull`. Phase 4 repoints Save to PUT /api/dev/onboarding-features-draft
 * (the gitignored draft) and makes POST /api/dev/onboarding-publish the ONLY path that
 * writes this committed file. No portal code calls this PUT anymore, so it now 405s to
 * guarantee the single committed-write invariant. The GET above is kept (it reads the
 * committed file as the publish baseline for the Studio's unpublished-diff badge).
 *
 * validateConfigBody is retained — it is the shared structural guard the draft router
 * mirrors; keeping the symbol referenced avoids an unused-export drift.
 */
router.put('/onboarding-features', (_req, res) => {
  if (!DEV) return res.status(404).end();
  void validateConfigBody;
  return res.status(405).json({
    error:
      'Direct writes to the committed onboarding features config are retired. Save to /api/dev/onboarding-features-draft and Publish via /api/dev/onboarding-publish.',
  });
});

export default router;
