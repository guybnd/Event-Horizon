import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { resolveSkillSourceRoot } from '../workspace.js';
import { isPathInsideRoot } from '../file-utils.js';
import { isPackaged } from '../packaged-mode.js';

// ─── Dev-only onboarding DRAFT store + PUBLISH endpoints (FLUX-763 Phase 4) ─────
//
// THE HEADLINE FIX. Before Phase 4, the Studio's Flow/Features Save wrote the
// COMMITTED configs directly (dev-onboarding-flow.ts PUT /onboarding-flow,
// dev-onboarding.ts PUT /onboarding-features), so merely opening the Studio and
// saving dirtied tracked files and blocked `git pull`. Phase 4 routes ALL routine
// Save to NEW gitignored DRAFT files:
//   - portal/src/config/onboardingFlow.draft.json
//   - portal/src/config/onboardingFeatures.draft.json
// and a single explicit PUBLISH endpoint is the ONLY path that writes the committed
// onboardingFlow.json / onboardingFeatures.json. The wizard keeps statically
// importing ONLY the committed JSON, so drafts never enter the prod bundle and using
// the Studio leaves the working tree clean.
//
// One router owns BOTH draft files + publish so the publish handler can read/write
// flow + features coherently in one place.
//
// Same dev-only posture as the FLUX-755/759/760 routes:
//   1. index.ts mounts it ONLY when DEV — never in a packaged build.
//   2. Each handler re-checks DEV and 404s as a backstop against an accidental mount.
//   3. Mounted WITHOUT requireWorkspace — the config files live in the EH SOURCE tree
//      (repo-relative), not the active workspace.
//   4. isTargetSafe() basename allowlist + isPathInsideRoot guard before any read/write.
//   5. Atomic temp-sibling + rename writes so a crash mid-write never corrupts JSON.
//
// DIVISION OF LABOR (mirror dev-onboarding-flow.ts:27-36 "portal owns normalization,
// engine refuses garbage"): the engine guards (validateFlowBody / validateConfigBody)
// only refuse STRUCTURALLY-broken JSON and persist the rest verbatim. The RICH
// author-facing validateOnboarding runs CLIENT-SIDE in the Studio before Publish; the
// engine publish route runs a SMALL structural backstop using its OWN local literals
// (NOT a portal import, to respect the package boundary) PLUS the asset-existence
// fs.access check (the one check only the server can do).

const router = express.Router();

/**
 * DEV gate (Node has no import.meta.env.DEV). isPackaged is true in pkg/SEA/electron
 * production binaries and false under tsx dev, so the router never serves when shipped.
 */
const DEV = !isPackaged && process.env.NODE_ENV !== 'production';

// All targets are computed ONCE, server-side, with NO value interpolated from the
// request — there is no path param and no filename in any body, so path traversal is
// structurally impossible. The guards below are belt-and-suspenders.
const CONFIG_DIR = path.join(resolveSkillSourceRoot(), 'portal', 'src', 'config');
// Committed asset dir (image-src existence check on publish). Matches dev-onboarding-assets.ts:54.
const ASSETS_DIR = path.join(resolveSkillSourceRoot(), 'portal', 'public', 'onboarding-assets');

// Committed configs (the publish targets — the ONLY committed write path).
const FLOW_COMMITTED = path.join(CONFIG_DIR, 'onboardingFlow.json');
const FLOW_COMMITTED_BASENAME = 'onboardingFlow.json';
const FEATURES_COMMITTED = path.join(CONFIG_DIR, 'onboardingFeatures.json');
const FEATURES_COMMITTED_BASENAME = 'onboardingFeatures.json';

// Gitignored drafts (the routine Save targets — never committed).
const FLOW_DRAFT = path.join(CONFIG_DIR, 'onboardingFlow.draft.json');
const FLOW_DRAFT_BASENAME = 'onboardingFlow.draft.json';
const FEATURES_DRAFT = path.join(CONFIG_DIR, 'onboardingFeatures.draft.json');
const FEATURES_DRAFT_BASENAME = 'onboardingFeatures.draft.json';

// The allowlist of basenames this router may touch inside CONFIG_DIR. Drafts (read +
// write by Save), committed configs (read for seeding + write by PUBLISH only).
const ALLOWED_CONFIG_BASENAMES = new Set<string>([
  FLOW_DRAFT_BASENAME,
  FEATURES_DRAFT_BASENAME,
  FLOW_COMMITTED_BASENAME,
  FEATURES_COMMITTED_BASENAME,
]);

/**
 * Defense-in-depth: assert a resolved target is an expected basename inside CONFIG_DIR
 * before any read/write. Returns false → caller responds 403.
 */
function isConfigTargetSafe(target: string): boolean {
  return ALLOWED_CONFIG_BASENAMES.has(path.basename(target)) && isPathInsideRoot(CONFIG_DIR, target);
}

/**
 * The ONLY widget ids the runtime resolves — mirrors OnboardingWidgetId
 * (portal config/onboardingFlow.ts). Local literal set so the route does NOT import
 * across the portal package boundary (same posture as dev-onboarding-flow.ts:69).
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
 * Required system widgets (SYSTEM_PAGE_SPECS[...].required === true). The publish
 * backstop refuses a flow missing any of these so the runtime can never produce a
 * setup with no folder/storage/assistant/completion step. Local literal — no import.
 */
const REQUIRED_SYSTEM_WIDGET_IDS = ['pick-folder', 'storage-mode', 'pick-assistant', 'completion'] as const;

/**
 * Strict flow body-shape validation — reject anything that is not
 * { version: number, pages: Array<page> }. Mirrors dev-onboarding-flow.ts.
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

interface OnboardingFeaturesConfigBody {
  version: number;
  features: unknown[];
}

/**
 * Strict features body-shape validation — reject anything that is not
 * { version: number, features: Array<{ id, icon, title, desc: string }> }.
 * Mirrors dev-onboarding.ts validateConfigBody.
 */
function validateConfigBody(body: unknown): body is OnboardingFeaturesConfigBody {
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

/** Atomic write (temp sibling + rename) so a crash mid-write never leaves corrupt JSON. */
async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  const tempFile = path.join(CONFIG_DIR, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempFile, serialized, 'utf-8');
  try {
    await fs.rename(tempFile, target);
  } catch (renameErr) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw renameErr;
  }
}

/**
 * Read a draft file's parsed JSON. On ENOENT, SEED the draft from the committed file
 * (atomic copy) so the draft ALWAYS starts equal to the published config, then return
 * the seeded value. The seed is an idempotent copy, so a concurrent first-load
 * GET+PUT double-seeding is harmless. Throws on a genuinely-unreadable committed file.
 */
async function readDraftSeedingFromCommitted(draftPath: string, committedPath: string): Promise<unknown> {
  try {
    const text = await fs.readFile(draftPath, 'utf-8');
    return JSON.parse(text);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    // Seed: copy committed → draft, then return the committed value.
    const committedText = await fs.readFile(committedPath, 'utf-8');
    const parsed = JSON.parse(committedText);
    await atomicWriteJson(draftPath, parsed);
    return parsed;
  }
}

// ─── Flow draft ────────────────────────────────────────────────────────────────

/** GET the flow DRAFT. ENOENT → seed from committed onboardingFlow.json and return it. */
router.get('/onboarding-flow-draft', async (_req, res) => {
  if (!DEV) return res.status(404).end();
  if (!isConfigTargetSafe(FLOW_DRAFT) || !isConfigTargetSafe(FLOW_COMMITTED)) {
    return res.status(403).json({ error: 'Refusing to read outside the config dir' });
  }
  try {
    const value = await readDraftSeedingFromCommitted(FLOW_DRAFT, FLOW_COMMITTED);
    return res.json(value);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return res.status(404).json({ error: 'Onboarding flow config not found' });
    }
    console.error('[dev-onboarding-draft] flow draft read failed:', err);
    return res.status(500).json({ error: 'Failed to read onboarding flow draft' });
  }
});

/** PUT the flow DRAFT (the gitignored Save target). validateFlowBody → atomic write. */
router.put('/onboarding-flow-draft', async (req, res) => {
  if (!DEV) return res.status(404).end();
  if (!isConfigTargetSafe(FLOW_DRAFT)) {
    return res.status(403).json({ error: 'Refusing to write outside the config dir' });
  }
  const body = req.body;
  if (!validateFlowBody(body)) {
    return res.status(400).json({
      error:
        'Body must be { version: number, pages: Array<{ id: string, title: string, kind: "widget"|"content", widget?: knownWidgetId }> }',
    });
  }
  try {
    await atomicWriteJson(FLOW_DRAFT, body);
    return res.json(body);
  } catch (err) {
    console.error('[dev-onboarding-draft] flow draft write failed:', err);
    return res.status(500).json({ error: 'Failed to write onboarding flow draft' });
  }
});

// ─── Features draft ──────────────────────────────────────────────────────────────

/** GET the features DRAFT. ENOENT → seed from committed onboardingFeatures.json. */
router.get('/onboarding-features-draft', async (_req, res) => {
  if (!DEV) return res.status(404).end();
  if (!isConfigTargetSafe(FEATURES_DRAFT) || !isConfigTargetSafe(FEATURES_COMMITTED)) {
    return res.status(403).json({ error: 'Refusing to read outside the config dir' });
  }
  try {
    const value = await readDraftSeedingFromCommitted(FEATURES_DRAFT, FEATURES_COMMITTED);
    return res.json(value);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return res.status(404).json({ error: 'Onboarding features config not found' });
    }
    console.error('[dev-onboarding-draft] features draft read failed:', err);
    return res.status(500).json({ error: 'Failed to read onboarding features draft' });
  }
});

/** PUT the features DRAFT (the gitignored Save target). validateConfigBody → atomic write. */
router.put('/onboarding-features-draft', async (req, res) => {
  if (!DEV) return res.status(404).end();
  if (!isConfigTargetSafe(FEATURES_DRAFT)) {
    return res.status(403).json({ error: 'Refusing to write outside the config dir' });
  }
  const body = req.body;
  if (!validateConfigBody(body)) {
    return res.status(400).json({
      error: 'Body must be { version: number, features: Array<{ id, icon, title, desc: string }> }',
    });
  }
  try {
    await atomicWriteJson(FEATURES_DRAFT, body);
    return res.json(body);
  } catch (err) {
    console.error('[dev-onboarding-draft] features draft write failed:', err);
    return res.status(500).json({ error: 'Failed to write onboarding features draft' });
  }
});

// ─── Publish (the ONLY committed write) ──────────────────────────────────────────

interface ValidationIssue {
  code: string;
  message: string;
  pageId?: string;
}

/** Collect /onboarding-assets/<file> src refs from a flow + features bundle. */
function collectAssetSrcs(flow: { pages?: unknown[] }, features: { features?: unknown[] }): string[] {
  const srcs: string[] = [];
  const pushImageSrc = (image: unknown) => {
    if (image && typeof image === 'object' && !Array.isArray(image)) {
      const src = (image as Record<string, unknown>).src;
      if (typeof src === 'string' && src.trim()) srcs.push(src.trim());
    }
  };
  for (const page of flow.pages ?? []) {
    if (page && typeof page === 'object' && !Array.isArray(page)) {
      pushImageSrc((page as Record<string, unknown>).image);
    }
  }
  for (const feature of features.features ?? []) {
    if (feature && typeof feature === 'object' && !Array.isArray(feature)) {
      pushImageSrc((feature as Record<string, unknown>).image);
    }
  }
  return srcs;
}

/**
 * Server-side asset-existence check — the ONE check only the server can do (the portal
 * can't stat files). For every root-absolute /onboarding-assets/<file> src, fs.access
 * it under ASSETS_DIR (exactly as dev-onboarding-assets.ts). Missing → WARNING (don't
 * block; the author may upload later). External http(s)/empty srcs are skipped.
 */
async function checkAssetSrcs(srcs: string[]): Promise<ValidationIssue[]> {
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    if (seen.has(src)) continue;
    seen.add(src);
    if (!src.startsWith('/onboarding-assets/')) continue; // external/relative → skip
    const fileName = path.basename(src);
    const target = path.join(ASSETS_DIR, fileName);
    // Path-guard the resolved target before stat'ing.
    if (path.basename(target) !== fileName || !isPathInsideRoot(ASSETS_DIR, target)) {
      warnings.push({ code: 'asset-unsafe-path', message: `Image src resolves outside the assets dir: ${src}` });
      continue;
    }
    try {
      await fs.access(target);
    } catch {
      warnings.push({ code: 'asset-missing', message: `Referenced image not found: ${src}` });
    }
  }
  return warnings;
}

/**
 * POST /api/dev/onboarding-publish — THE ONLY COMMITTED WRITE.
 * Re-reads BOTH drafts from disk (seeding from committed if missing), runs the
 * structural backstop (validateFlowBody + validateConfigBody + required-system-present),
 * plus the asset-existence fs.access check (warnings only). On a BLOCKING error → 422
 * { errors }, writes NOTHING. Else atomically writes flow draft → onboardingFlow.json
 * THEN features draft → onboardingFeatures.json (two temp+rename writes; if the 2nd
 * fails, reports a partial-publish error). Returns { published: true, warnings }.
 */
router.post('/onboarding-publish', async (_req, res) => {
  if (!DEV) return res.status(404).end();
  if (
    !isConfigTargetSafe(FLOW_DRAFT) ||
    !isConfigTargetSafe(FEATURES_DRAFT) ||
    !isConfigTargetSafe(FLOW_COMMITTED) ||
    !isConfigTargetSafe(FEATURES_COMMITTED)
  ) {
    return res.status(403).json({ error: 'Refusing to read/write outside the config dir' });
  }

  let flowDraft: unknown;
  let featuresDraft: unknown;
  try {
    flowDraft = await readDraftSeedingFromCommitted(FLOW_DRAFT, FLOW_COMMITTED);
    featuresDraft = await readDraftSeedingFromCommitted(FEATURES_DRAFT, FEATURES_COMMITTED);
  } catch (err: unknown) {
    console.error('[dev-onboarding-draft] publish read failed:', err);
    return res.status(500).json({ error: 'Failed to read onboarding drafts for publish' });
  }

  const errors: ValidationIssue[] = [];

  // Structural backstop — refuse garbage (mirrors the per-file PUT guards).
  if (!validateFlowBody(flowDraft)) {
    errors.push({ code: 'flow-structure', message: 'Flow draft is structurally invalid.' });
  }
  if (!validateConfigBody(featuresDraft)) {
    errors.push({ code: 'features-structure', message: 'Features draft is structurally invalid.' });
  }

  // Required-system-present check — every required:true widget must exist in the flow.
  if (validateFlowBody(flowDraft)) {
    const widgetIds = new Set<string>();
    for (const page of flowDraft.pages) {
      if (page && typeof page === 'object' && !Array.isArray(page)) {
        const w = (page as Record<string, unknown>).widget;
        if (typeof w === 'string') widgetIds.add(w);
      }
    }
    for (const required of REQUIRED_SYSTEM_WIDGET_IDS) {
      if (!widgetIds.has(required)) {
        errors.push({
          code: 'missing-required-system-page',
          message: `Required system page "${required}" is missing from the flow.`,
        });
      }
    }
  }

  if (errors.length > 0) {
    return res.status(422).json({ errors });
  }

  // Asset-existence WARNINGS (non-blocking) — only meaningful once structure passed.
  const warnings = await checkAssetSrcs(
    collectAssetSrcs(flowDraft as { pages?: unknown[] }, featuresDraft as { features?: unknown[] }),
  );

  // Atomic write both committed files. Flow first, then features. If the 2nd fails the
  // 1st already landed — report a partial-publish error so the author re-publishes.
  try {
    await atomicWriteJson(FLOW_COMMITTED, flowDraft);
  } catch (err) {
    console.error('[dev-onboarding-draft] publish flow write failed:', err);
    return res.status(500).json({ error: 'Failed to publish onboarding flow config' });
  }
  try {
    await atomicWriteJson(FEATURES_COMMITTED, featuresDraft);
  } catch (err) {
    console.error('[dev-onboarding-draft] publish features write failed:', err);
    return res.status(500).json({
      error:
        'Partial publish: the flow config was written but the features config failed. Re-run Publish to finish.',
    });
  }

  return res.json({ published: true, warnings });
});

// ─── Discard (revert both drafts to committed) ───────────────────────────────────

/**
 * POST /api/dev/onboarding-discard — overwrite BOTH drafts from the committed configs,
 * dropping any unpublished edits. Optional convenience; never touches committed files.
 */
router.post('/onboarding-discard', async (_req, res) => {
  if (!DEV) return res.status(404).end();
  if (
    !isConfigTargetSafe(FLOW_DRAFT) ||
    !isConfigTargetSafe(FEATURES_DRAFT) ||
    !isConfigTargetSafe(FLOW_COMMITTED) ||
    !isConfigTargetSafe(FEATURES_COMMITTED)
  ) {
    return res.status(403).json({ error: 'Refusing to read/write outside the config dir' });
  }
  try {
    const flowText = await fs.readFile(FLOW_COMMITTED, 'utf-8');
    const featuresText = await fs.readFile(FEATURES_COMMITTED, 'utf-8');
    const flow = JSON.parse(flowText);
    const features = JSON.parse(featuresText);
    await atomicWriteJson(FLOW_DRAFT, flow);
    await atomicWriteJson(FEATURES_DRAFT, features);
    return res.json({ flow, features });
  } catch (err) {
    console.error('[dev-onboarding-draft] discard failed:', err);
    return res.status(500).json({ error: 'Failed to discard onboarding drafts' });
  }
});

export default router;
