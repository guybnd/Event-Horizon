import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { resolveSkillSourceRoot } from '../workspace.js';
import {
  isPathInsideRoot,
  sanitizeAssetBaseName,
  normalizeBase64Content,
  resolveOnboardingImageExtension,
  ONBOARDING_IMAGE_EXTENSIONS,
} from '../file-utils.js';
import { isPackaged } from '../packaged-mode.js';

// ─── Dev-only onboarding-IMAGE upload endpoint (FLUX-760) ──────────────────────
//
// Writes a committed onboarding image (page/feature) into the EH SOURCE tree at
// portal/public/onboarding-assets/<kind>-<id>.<ext>. Vite copies portal/public/**
// verbatim into portal/dist/**, and the engine serves dist via express.static
// (index.ts), so /onboarding-assets/<file> resolves in dev AND prod with NO new
// serving code and — critically — NO re-encode (raw bytes are written, so animated
// gifs stay animated). The Studio then Saves the config (existing flow/features PUT)
// to persist image.src = '/onboarding-assets/<file>' into committed JSON: this route
// writes the FILE, the Save writes the PATH.
//
// Near-verbatim clone of dev-onboarding-flow.ts:
//   - Same DEV gate + per-handler 404 backstop.
//   - Same atomic temp-sibling + rename write.
//   - Same path-guard (basename + isPathInsideRoot) before any write.
//   - Mounted WITHOUT requireWorkspace (target is repo-relative, not workspace-relative)
//     and ONLY inside index.ts's `if (DEV)` block.
//
// SECURITY: the filename is DERIVED server-side from kind + sanitized id, NEVER from
// the client-supplied fileName (which is used only as an extension fallback after the
// MIME-first allowlist). The id flows into the path, so it is sanitized AND the
// resolved target is asserted to be the exact expected basename inside ASSETS_DIR
// before writing.
//
// SIZE: this router mounts its OWN express.json({ limit: '64mb' }) — gifs are large
// and base64 inflates ~33%, so the prod-wide 10mb /api limit (index.ts) would 413 a
// ~7.5mb gif before this handler runs. The prod-wide limit is NOT widened; the larger
// limit is scoped to this dev-only router only. A decoded-byte cap below adds a clear
// 413 the Studio can surface.

const router = express.Router();

/**
 * DEV gate (Node has no import.meta.env.DEV). isPackaged is true in pkg/SEA/electron
 * production binaries and false under tsx dev, so the router never serves when shipped.
 */
const DEV = !isPackaged && process.env.NODE_ENV !== 'production';

// Committed asset dir in the EH source tree. resolveSkillSourceRoot() returns the repo
// root in dev — the same anchor dev-onboarding-flow.ts uses for portal/src/config.
const ASSETS_DIR = path.join(resolveSkillSourceRoot(), 'portal', 'public', 'onboarding-assets');

/** Hard cap on decoded media bytes (gifs/videos are large; base64 transport caps higher). */
const MAX_DECODED_BYTES = 64 * 1024 * 1024; // 64 MB — holds a sharp ~10-30s muted-loop H.264 mp4.

/**
 * Larger body limit scoped to THIS router only — never the prod-wide /api limit.
 * MUST stay above MAX_DECODED_BYTES inflated by base64 (~33%): a 64MB decoded file is
 * ~85MB encoded, so 96mb avoids an opaque body-parser 413 BEFORE the clean
 * decoded-byte 413 the Studio surfaces. Raise both together.
 */
const jsonForAssets = express.json({ limit: '96mb' });

type AssetKind = 'page' | 'feature';

function isAssetKind(value: unknown): value is AssetKind {
  return value === 'page' || value === 'feature';
}

/**
 * Build the deterministic, id-derived target filename + path. The basename is
 * `<kind>-<sanitizedId><ext>` so a re-upload OVERWRITES in place (clean git diff, no
 * orphans) — intentionally NOT createUniqueAssetFileName. The id is sanitized so it
 * cannot escape the dir; callers pass only non-empty ids (validated upstream).
 */
function resolveAssetTarget(kind: AssetKind, id: string, extension: string) {
  const safeId = sanitizeAssetBaseName(id);
  const fileName = `${kind}-${safeId}${extension}`;
  const target = path.join(ASSETS_DIR, fileName);
  return { fileName, target };
}

/**
 * Defense-in-depth path guard: the resolved target must be exactly the expected
 * basename and must resolve inside ASSETS_DIR. Returns false → caller responds 403.
 */
function isTargetSafe(fileName: string, target: string): boolean {
  return path.basename(target) === fileName && isPathInsideRoot(ASSETS_DIR, target);
}

/**
 * POST /api/dev/onboarding-asset
 * Body: { kind: 'page'|'feature', id: string, fileName: string, mimeType: string, content: base64|dataURL }
 * Writes raw bytes (NO re-encode) to portal/public/onboarding-assets/<kind>-<id>.<ext>.
 * 201 { url: '/onboarding-assets/<file>', fileName }.
 */
router.post('/onboarding-asset', jsonForAssets, async (req, res) => {
  if (!DEV) return res.status(404).end();

  const kind = req.body?.kind;
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
  const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : '';

  if (!isAssetKind(kind)) {
    return res.status(400).json({ error: "Body.kind must be 'page' or 'feature'" });
  }
  if (!id) {
    return res.status(400).json({ error: 'Body.id is required' });
  }

  const extension = resolveOnboardingImageExtension(fileName, mimeType);
  if (!extension) {
    return res
      .status(400)
      .json({ error: 'Only PNG, JPG, SVG, GIF, MP4, and WebM onboarding media are supported.' });
  }

  const { fileName: storedFileName, target } = resolveAssetTarget(kind, id, extension);

  if (!isTargetSafe(storedFileName, target)) {
    return res.status(403).json({ error: 'Refusing to write outside the onboarding-assets dir' });
  }

  const normalizedContent = normalizeBase64Content(content);
  if (!normalizedContent) {
    return res.status(400).json({ error: 'Missing asset content' });
  }

  const fileBuffer = Buffer.from(normalizedContent, 'base64');
  if (fileBuffer.length === 0) {
    return res.status(400).json({ error: 'Invalid asset content' });
  }
  if (fileBuffer.length > MAX_DECODED_BYTES) {
    return res.status(413).json({
      error: `Media too large: ${Math.round(fileBuffer.length / (1024 * 1024))}MB exceeds the ${Math.round(
        MAX_DECODED_BYTES / (1024 * 1024),
      )}MB onboarding media limit.`,
    });
  }

  try {
    await fs.mkdir(ASSETS_DIR, { recursive: true });

    // Atomic write: temp sibling + rename so a crash mid-write never leaves a
    // half-written image. Raw bytes only — NO re-encode (gif animation preserved).
    const tempFile = path.join(ASSETS_DIR, `.${storedFileName}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tempFile, fileBuffer);
    try {
      await fs.rename(tempFile, target);
    } catch (renameErr) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      throw renameErr;
    }

    return res.status(201).json({ url: `/onboarding-assets/${storedFileName}`, fileName: storedFileName });
  } catch (err) {
    console.error('[dev-onboarding-assets] write failed:', err);
    return res.status(500).json({ error: 'Failed to write onboarding asset' });
  }
});

/**
 * DELETE /api/dev/onboarding-asset?kind=&id=
 * Removes the committed file for the given kind+id. Idempotent: a missing file is a
 * success (the caller's intent — "no image" — is satisfied). The Studio blanks the
 * config ref separately via Save; this just cleans the committed bytes.
 */
router.delete('/onboarding-asset', async (req, res) => {
  if (!DEV) return res.status(404).end();

  const kind = req.query?.kind;
  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';

  if (!isAssetKind(kind)) {
    return res.status(400).json({ error: "Query.kind must be 'page' or 'feature'" });
  }
  if (!id) {
    return res.status(400).json({ error: 'Query.id is required' });
  }

  // Delete must cover every allowed extension for this kind+id (the caller doesn't
  // know which extension the committed file used).
  const safeId = sanitizeAssetBaseName(id);
  if (!id.trim() || !safeId) {
    return res.status(400).json({ error: 'Query.id did not resolve to a usable filename' });
  }

  try {
    let removed = false;
    // Drive the delete set from the SAME allowlist as upload so it never drifts and now
    // also cleans committed .mp4/.webm/.mov. Dedupe .jpeg→.jpg (both map to the .jpg file).
    const deleteExtensions = new Set(
      [...ONBOARDING_IMAGE_EXTENSIONS].map((ext) => (ext === '.jpeg' ? '.jpg' : ext)),
    );
    for (const extension of deleteExtensions) {
      const fileName = `${kind}-${safeId}${extension}`;
      const target = path.join(ASSETS_DIR, fileName);
      if (!isTargetSafe(fileName, target)) {
        return res.status(403).json({ error: 'Refusing to delete outside the onboarding-assets dir' });
      }
      try {
        await fs.rm(target);
        removed = true;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    return res.status(200).json({ removed });
  } catch (err) {
    console.error('[dev-onboarding-assets] delete failed:', err);
    return res.status(500).json({ error: 'Failed to delete onboarding asset' });
  }
});

export default router;
