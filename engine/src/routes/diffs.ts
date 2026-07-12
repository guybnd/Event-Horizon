import { getWorkspace } from '../workspace-context.js';
import express from 'express';
import { getWorkspaceRoot } from '../workspace.js';

import { buildDiffOverview, diffFileContent } from '../diff-aggregator.js';

const router = express.Router();

// GET /api/diffs/overview — cross-worktree change overview (FLUX-527/528/529).
// One group per active worktree (+ collision radar) plus the main tree's loose
// uncommitted changes. Worktree groups are enriched with their owning ticket.
router.get('/overview', async (req, res) => {
  try {
    // ?uncommitted=1 → loose working-tree changes per root (powers the board
    // header uncommitted panel); default → branch divergence vs merge-base.
    const uncommittedOnly = req.query.uncommitted === '1';
    const overview = await buildDiffOverview(getWorkspaceRoot()!, uncommittedOnly ? { uncommittedOnly: true } : {});
    const groups = overview.groups.map((g) => {
      if (g.kind !== 'worktree' || !g.branch) return g;
      const ticket = Object.values(getWorkspace().tasks).find((t) => t.branch === g.branch);
      return { ...g, ticketId: ticket?.id ?? null, ticketTitle: ticket?.title ?? null };
    });
    res.json({ groups, collisions: overview.collisions });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/diffs/file?ref=<branch|main>&path=<file> — one file's unified diff in
// the correct root (main → engine root vs HEAD; a branch → its worktree vs merge-base).
router.get('/file', async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  const file = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!ref || !file) return res.status(400).json({ error: 'ref and path are required' });
  // git `-- <file>` is repo-scoped (and execFile avoids shell injection), but reject
  // absolute / traversal paths anyway so nothing outside the repo can be probed.
  if (file.startsWith('/') || file.includes('..') || /^[a-zA-Z]:/.test(file)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    const diff = await diffFileContent(getWorkspaceRoot()!, ref, file);
    if (!diff) return res.status(404).json({ error: 'No diff for that file' });
    res.type('text/plain').send(diff);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
