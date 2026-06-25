import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { resolveSkillSourceRoot } from '../workspace.js';
import { isPathInsideRoot } from '../file-utils.js';
import { isPackaged } from '../packaged-mode.js';

// ─── Dev-only onboarding-FLOW editor endpoints (FLUX-759) ──────────────────────
//
// Reads/writes the SINGLE committed onboarding flow config that drives the wizard's
// page sequence (portal/src/config/onboardingFlow.json), so the hidden /dev/onboarding
// Studio (Flow tab) can preview + persist per-page edits with a clean git diff.
//
// This is a near-verbatim clone of dev-onboarding.ts (the FLUX-755 features route),
// targeting onboardingFlow.json instead of onboardingFeatures.json. It does NOT
// overload the features route — two distinct sub-paths under the shared /api/dev
// prefix (/onboarding-features vs /onboarding-flow) so there is no collision.
//
// This router is dev-only on TWO independent layers:
//   1. index.ts mounts it ONLY when DEV (see below) — never in a packaged build.
//   2. Each handler re-checks DEV and 404s as a backstop against an accidental mount.
//
// It is mounted WITHOUT requireWorkspace on purpose: the config file lives in the
// EH SOURCE tree (repo-relative), not in the active workspace, so requireWorkspace
// would resolve the wrong root.
//
// DIVISION OF LABOR (read before assuming the engine canonicalizes):
//   The engine guard (validateFlowBody) only refuses STRUCTURALLY-broken JSON and
//   writes the RAW validated-shape body verbatim. It deliberately does NOT import or
//   call the portal's validateFlow — that function NEVER throws and silently falls
//   back to DEFAULT_FLOW, so using it as a validator would turn garbage into
//   DEFAULT_FLOW (data loss masquerading as success). The authoritative normalization
//   (SYSTEM_PAGE_SPECS merge, required re-injection, canonical topo re-derive) is the
//   PORTAL's job: validateFlow runs at load AND the client runs it pre-save. The
//   engine's job here mirrors validateConfigBody for the features route: refuse
//   garbage, persist the rest unchanged.

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
const FLOW_FILE = path.join(CONFIG_DIR, 'onboardingFlow.json');
const FLOW_BASENAME = 'onboardingFlow.json';

/**
 * Defense-in-depth: assert the resolved target is exactly the expected file inside
 * the expected dir before any read/write. Returns false → caller responds 403.
 */
function isTargetSafe(): boolean {
  return (
    path.basename(FLOW_FILE) === FLOW_BASENAME &&
    isPathInsideRoot(CONFIG_DIR, FLOW_FILE)
  );
}

/**
 * The ONLY widget ids the runtime WIDGET_RENDERERS registry resolves — mirrors the
 * portal's OnboardingWidgetId union (config/onboardingFlow.ts). Kept as a local
 * literal set so the route does NOT import across the portal package boundary.
 */
const KNOWN_WIDGET_IDS = new Set<string>([
  'pick-folder',
  'storage-mode',
  'pick-assistant',
  'install-skill',
  'bootstrap',
  'path-setup',
  'completion',
]);

/**
 * Strict PUT body-shape validation — reject (400, write nothing) anything that is
 * not { version: number, pages: Array<page> } where each page is a non-array object
 * with a string `id`, a string `title`, and `kind` in {'widget','content'} (and,
 * when kind==='widget', a known `widget` string). This is the structural pre-check
 * that prevents garbage from ever reaching the committed file. It does NOT
 * normalize — see the DIVISION OF LABOR note above.
 */
function validateFlowBody(body: unknown): body is { version: number; pages: unknown[] } {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.version !== 'number' || !Number.isFinite(candidate.version)) return false;
  if (!Array.isArray(candidate.pages)) return false;
  return candidate.pages.every((entry) => {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string') return false;
    if (typeof item.title !== 'string') return false;
    if (item.kind !== 'widget' && item.kind !== 'content') return false;
    if (item.kind === 'widget') {
      if (typeof item.widget !== 'string' || !KNOWN_WIDGET_IDS.has(item.widget)) return false;
    }
    return true;
  });
}

/** GET the parsed onboarding flow config ({ version, pages }). 404 on ENOENT. */
router.get('/onboarding-flow', async (_req, res) => {
  if (!DEV) return res.status(404).end();
  if (!isTargetSafe()) return res.status(403).json({ error: 'Refusing to read outside the config dir' });

  try {
    const text = await fs.readFile(FLOW_FILE, 'utf-8');
    return res.json(JSON.parse(text));
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return res.status(404).json({ error: 'Onboarding flow config not found' });
    }
    console.error('[dev-onboarding-flow] read failed:', err);
    return res.status(500).json({ error: 'Failed to read onboarding flow config' });
  }
});

/**
 * PUT the onboarding flow config — RETIRED (FLUX-763 Phase 4).
 *
 * This used to be the Studio Flow-tab Save target, writing the COMMITTED
 * onboardingFlow.json directly — which dirtied a tracked file on every save and blocked
 * `git pull`. Phase 4 repoints Save to PUT /api/dev/onboarding-flow-draft (the
 * gitignored draft) and makes POST /api/dev/onboarding-publish the ONLY path that
 * writes this committed file. No portal code calls this PUT anymore, so it now 405s to
 * guarantee the single committed-write invariant. The GET above is kept (it reads the
 * committed file as the publish baseline for the Studio's unpublished-diff badge).
 *
 * validateFlowBody is retained — it is the shared structural guard the draft router
 * mirrors; keeping the symbol referenced avoids an unused-export drift.
 */
router.put('/onboarding-flow', (_req, res) => {
  if (!DEV) return res.status(404).end();
  void validateFlowBody;
  return res.status(405).json({
    error:
      'Direct writes to the committed onboarding flow config are retired. Save to /api/dev/onboarding-flow-draft and Publish via /api/dev/onboarding-publish.',
  });
});

export default router;
