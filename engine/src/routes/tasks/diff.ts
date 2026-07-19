// Diff + artifact sidecar routes (FLUX-349 split): the stored/live ticket diff, the live
// branch-diff summary, and the grooming-artifact HTML sidecar (which mirrors the diff route's
// revision-keyed sidecar shape).
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getActiveFluxDir, getWorkspaceRoot } from '../../workspace.js';

import { extractFileFromDiff, captureDiff } from '../../branch-manager.js';
import { diffFilesForBranch } from '../../diff-aggregator.js';
import { ARTIFACT_CSP, injectArtifactScripts, isSafeTicketId, parseRevParam, readArtifactRevision } from '../../artifacts.js';
import { errorMessage } from './helpers.js';

const router = express.Router();

// ─── Diff sidecar route ────────────────────────────────────────────────────────

router.get('/:id/diff', async (req, res) => {
  const { id } = req.params;
  const task = (req.workspace ?? getWorkspace()).tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const mode = req.query.mode === 'working' ? 'working' : 'committed';
  let fullDiff: string;

  if (mode === 'working') {
    // Live diff: generate it on the fly from the current working tree vs baseline
    try {
      const diff = await captureDiff(task.branch ?? null, task.baselineCommit ?? null, 'working');
      if (!diff) return res.status(404).json({ error: 'Could not generate live diff' });
      fullDiff = diff.fullDiff;
    } catch (err: unknown) {
      return res.status(500).json({ error: `Live diff failed: ${errorMessage(err)}` });
    }
  } else {
    // Committed diff: read the sidecar file stored at finish
    const diffPath = path.join(getActiveFluxDir(), `${id}.diff`);
    try {
      fullDiff = await fs.readFile(diffPath, 'utf-8');
    } catch {
      return res.status(404).json({ error: 'No diff stored for this ticket' });
    }
  }

  const file = typeof req.query.file === 'string' ? req.query.file : null;
  if (file) {
    const hunk = extractFileFromDiff(fullDiff, file);
    if (!hunk) return res.status(404).json({ error: `File ${file} not present in diff` });
    res.type('text/plain').send(hunk);
    return;
  }
  res.type('text/plain').send(fullDiff);
});

// ─── Grooming artifact sidecar route (FLUX-873) ─────────────────────────────────
//
// Serve a revision of a ticket's rich grooming artifact as a self-contained HTML page. Mirrors the
// diff route's shape (read a revision-keyed sidecar, default to latest) but adds the security
// hardening the feature requires: the agent-authored HTML is served with a strict CSP + nosniff so
// the portal can render it in a `<iframe sandbox="allow-scripts">` (NO allow-same-origin → opaque
// origin, no access to portal cookies/DOM/storage). `rev` is parsed to a positive integer or
// 'latest' and the file path is traversal-guarded inside the artifacts root (see artifacts.ts).
// Board-scoped via header OR `?ws=` (the portal iframe can't send headers — see attachWorkspace);
// the workspaceScope binding makes readArtifactRevision's internal flux-dir resolution follow too.
router.get('/:id/artifact', async (req, res) => {
  const { id } = req.params;
  const task = (req.workspace ?? getWorkspace()).tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (!isSafeTicketId(id)) return res.status(400).json({ error: 'Invalid ticket id' });

  const rev = parseRevParam(req.query.rev);
  if (rev === null) {
    return res.status(400).json({ error: 'Invalid rev — must be a positive integer or "latest"' });
  }

  const result = await readArtifactRevision(id, rev, task.artifacts);
  if (!result) return res.status(404).json({ error: 'No artifact stored for this ticket/revision' });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', ARTIFACT_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Artifact-Revision', String(result.rev));
  // FLUX-874/875 (Tier 2+3): inject the serve-time runtime — the anchor-capture/annotation channel
  // AND the layout-audit gate — at serve time (stored file stays pristine). Permitted by the CSP's
  // `script-src 'unsafe-inline'` — no header change needed.
  res.send(injectArtifactScripts(result.html));
});

// GET /api/tasks/:id/branch-diff — live changed-file summary for the ticket's branch vs
// the merge-base (FLUX-615), powering the inline diff panel in the chat window. Worktree-
// aware (same plumbing as /api/diffs/file), so per-file hunks fetched via that endpoint
// line up with this summary. 404-free for "no branch" — returns an empty summary instead.
router.get('/:id/branch-diff', async (req, res) => {
  const { id } = req.params;
  const task = (req.workspace ?? getWorkspace()).tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (!task.branch) return res.json({ branch: null, worktree: null, base: null, files: [] });

  try {
    const summary = await diffFilesForBranch(getWorkspaceRoot()!, task.branch);
    res.json(summary);
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
