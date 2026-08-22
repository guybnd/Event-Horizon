import { getWorkspace } from '../workspace-context.js';
import express from 'express';
import path from 'path';
import matter from 'gray-matter';
import { getWorkspaceRoot } from '../workspace.js';

import { buildDiffOverview, diffFileContent, fileContentPair, isDocsRootMarkdownFile } from '../diff-aggregator.js';
import { findWorktreeForBranch } from '../task-worktree.js';
import { getBlockingSessionsForRef } from '../session-store.js';
import { runGit } from '../git-exec.js';
import { writeDocFile, titleFromDocPath, parseDocOrder } from '../file-utils.js';
import { emitDocRecap, emitDocRecapForBranch, findTicketIdForBranch, resolveBaselineCommitForBranch } from '../doc-recap-emit.js';

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
    const baselineCommit = resolveBaselineCommitForBranch(ref, getWorkspace());
    const diff = await diffFileContent(getWorkspaceRoot()!, ref, file, { baselineCommit });
    if (!diff) return res.status(404).json({ error: 'No diff for that file' });
    res.type('text/plain').send(diff);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/diffs/file/content?ref=<branch|main>&path=<file> — one file's raw before/after content
// in the correct root, for a RENDERED (not unified-diff) preview of a changed docsRoot .md file
// (FLUX-1653). Mirrors /file's request shape and path-traversal guard.
router.get('/file/content', async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  const file = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!ref || !file) return res.status(400).json({ error: 'ref and path are required' });
  if (file.startsWith('/') || file.includes('..') || /^[a-zA-Z]:/.test(file)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    const baselineCommit = resolveBaselineCommitForBranch(ref, getWorkspace());
    const pair = await fileContentPair(getWorkspaceRoot()!, ref, file, { baselineCommit });
    res.json(pair);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/diffs/file/commit — edit a changed docsRoot .md file inline from the PR/diff view and
// commit it straight into the branch's worktree (FLUX-1653). Never touches 'main' (no worktree to
// scope a commit to safely) and never races an active agent session in that checkout — same guards
// as /api/tasks/discard. Commit is pathspec-scoped to the one file; push is best-effort (a push
// failure still leaves the local commit and is surfaced, not swallowed).
router.post('/file/commit', async (req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No active workspace' });

  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : '';
  const file = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const push = req.body?.push !== false; // default true (commit-and-push, per plan decision 5)

  if (!ref || ref === 'main') {
    return res.status(409).json({ error: 'Inline commits require a ticket branch with a live worktree, not the main tree.' });
  }
  if (!file || file.startsWith('/') || file.includes('..') || /^[a-zA-Z]:/.test(file)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!isDocsRootMarkdownFile(file)) {
    return res.status(400).json({ error: 'Only docs files under the configured docsRoot can be edited inline' });
  }
  if (!message) return res.status(400).json({ error: 'Commit message is required' });

  const worktree = await findWorktreeForBranch(workspaceRoot, ref).catch(() => null);
  if (!worktree) {
    return res.status(409).json({ error: `No active worktree holds branch "${ref}" — refusing to commit into a guessed checkout` });
  }

  const tasks = Object.values(getWorkspace().tasks) as Array<{ id: string; branch?: string | null }>;
  if (getBlockingSessionsForRef(ref, worktree, tasks).length > 0) {
    return res.status(409).json({ error: 'An agent session is actively working in this checkout — wait for it to finish before committing an edit.' });
  }

  try {
    const parsed = matter(content);
    const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : titleFromDocPath(path.basename(file, '.md'));
    const order = parseDocOrder(parsed.data.order);
    const { title: _title, order: _order, ...extra } = parsed.data;
    const absoluteFilePath = path.join(worktree, file);
    await writeDocFile(absoluteFilePath, title, order, parsed.content.replace(/\r\n/g, '\n'), extra);

    await runGit(['add', '--', file], { cwd: worktree });
    await runGit(['commit', '-m', message, '--', file], { cwd: worktree });
    const { stdout: hashOut } = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: worktree });
    const hash = hashOut.trim();

    let pushed = false;
    let pushError: string | undefined;
    if (push) {
      try {
        await runGit(['push', 'origin', ref], { cwd: worktree });
        pushed = true;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
      }
    }

    // FLUX-1662 (Phase B step 10): close the loop — re-emit the owning ticket's doc-recap so the
    // rendered after-state reflects this self-serve edit. Resolved by branch (not a param on this
    // route). emitDocRecap never throws (it swallows its own errors), so awaiting it here still
    // can't fail this response — awaited only so the new revision is visible by the time it returns.
    const ticketId = findTicketIdForBranch(ref);
    if (ticketId) {
      const task = getWorkspace().tasks[ticketId];
      await emitDocRecap(ticketId, ref, task?.baselineCommit ?? '', req.workspace);
      // FLUX-1670: also refresh the PR ticket's own doc-recap (if one owns this branch).
      await emitDocRecapForBranch(ref, req.workspace).catch(() => {});
    }

    res.json({ hash, pushed, ...(pushError ? { pushError } : {}) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
