import express from 'express';
import { workspaceRoot } from '../workspace.js';
import { tasksCache } from '../task-store.js';
import { buildDiffOverview, diffFileContent } from '../diff-aggregator.js';

const router = express.Router();

// GET /api/diffs/overview — cross-worktree change overview (FLUX-527/528/529).
// One group per active worktree (+ collision radar) plus the main tree's loose
// uncommitted changes. Worktree groups are enriched with their owning ticket.
router.get('/overview', async (_req, res) => {
  try {
    const overview = await buildDiffOverview(workspaceRoot!);
    const groups = overview.groups.map((g) => {
      if (g.kind !== 'worktree' || !g.branch) return g;
      const ticket = Object.values(tasksCache).find((t: any) => t.branch === g.branch) as any;
      return { ...g, ticketId: ticket?.id ?? null, ticketTitle: ticket?.title ?? null };
    });
    res.json({ groups, collisions: overview.collisions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    const diff = await diffFileContent(workspaceRoot!, ref, file);
    if (!diff) return res.status(404).json({ error: 'No diff for that file' });
    res.type('text/plain').send(diff);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
