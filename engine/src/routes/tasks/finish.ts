// Branchless engine-side finish (FLUX-618; FLUX-349 split) — the zero-token sibling of
// POST /:id/pr/merge (pr.ts).
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getActiveFluxDir, getWorkspaceRoot } from '../../workspace.js';
import { getConfig } from '../../config.js';
import { buildActivityEntry } from '../../history.js';
import { updateTaskWithHistory } from '../../task-store.js';
import { reapStaleParkedSessions } from '../../session-store.js';
import { captureDiff, resolveCommit } from '../../branch-manager.js';
import { broadcastEvent } from '../../events.js';
import { git, errorMessage, gitErrorDetail, reqWorkspace } from './helpers.js';
import type { TaskRecord } from './helpers.js';

const router = express.Router();

// Engine-side finish for BRANCHLESS tickets (FLUX-618) — the zero-token sibling of POST /:id/pr/merge.
// Branch/PR tickets finish by merging their open PR (that route, unchanged); a branchless ticket needs
// a curated commit, which used to require a tokenized agent `finish`. Here the portal supplies the
// curated commit message + the EXPLICIT file list it showed the user (NO silent `git add -A` — the
// real footgun called out in grooming), and the engine stages exactly those, commits, then runs the
// SAME tail as finish_ticket's branchless path (engine/src/mcp-server.ts): completion comment,
// implementationLink = commit hash, swimlane cleared, baseline lazy-repair + diff capture + .diff
// sidecar, status → Done, reap stale parked sessions.
router.post('/:id/finish', async (req, res) => {
  const { id } = req.params;
  const task = reqWorkspace(req).tasks[id] as TaskRecord;
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  // Branch/PR tickets must finish through the PR-merge surface — never commit straight to their tree here.
  if (task.branch) {
    return res.status(409).json({ error: `Ticket ${id} has a branch (\`${task.branch}\`) — finish it by merging its PR, not the branchless finish route.` });
  }

  // Same guard as finish_ticket (mcp-server.ts): only a Ready ticket can finish.
  const readyStatus = getConfig().readyForMergeStatus || 'Ready';
  if (task.status !== readyStatus) {
    return res.status(409).json({ error: `Cannot finish ${id} — ticket must be in "${readyStatus}" status first (current: "${task.status}").` });
  }

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No active workspace' });

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const completionComment = typeof req.body?.completionComment === 'string' && req.body.completionComment.trim()
    ? req.body.completionComment.trim()
    : message;
  const files: string[] = Array.isArray(req.body?.files)
    ? req.body.files.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0).map((f: string) => f.trim())
    : [];
  if (!message) return res.status(400).json({ error: 'A commit message is required to finish.' });
  // Explicit-staging contract (FLUX-618): the route NEVER sweeps the tree. The portal sends the exact
  // files it showed the user; an empty list means there is nothing safe to stage → refuse.
  if (files.length === 0) return res.status(400).json({ error: 'No files to commit — stage changes first (this route never runs git add -A).' });
  for (const f of files) {
    if (f.startsWith('/') || f.includes('..') || /^[a-zA-Z]:/.test(f)) {
      return res.status(400).json({ error: `Invalid path: ${f}` });
    }
  }

  // 1) Stage ONLY the explicit paths + commit them (pathspec-scoped, mirroring POST /commit so any
  //    other staged changes in the index never ride along).
  let hash: string;
  try {
    await git(workspaceRoot, ['add', '--', ...files]);
    await git(workspaceRoot, ['commit', '-m', message, '--', ...files]);
    const { stdout } = await git(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
    hash = stdout.trim();
  } catch (err: unknown) {
    return res.status(500).json({ error: `Commit failed: ${gitErrorDetail(err, 'Commit failed')}` });
  }

  // 2) Finish tail — verbatim mirror of finish_ticket's branchless path.
  const finishExtraFields: Record<string, unknown> = { implementationLink: hash, swimlane: null };
  try {
    // Lazy baseline repair: by finish time the new commit is HEAD, so a missing baseline anchors at
    // the parent (HEAD~1..HEAD); HEAD itself would yield an empty HEAD..HEAD range.
    if (!task.baselineCommit) {
      const parent = await resolveCommit('HEAD~1');
      if (parent) {
        await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { baselineCommit: parent } }, req.workspace);
        task.baselineCommit = parent;
      }
    }
    const diff = await captureDiff(null, task.baselineCommit ?? null);
    if (diff && diff.summary.length > 0) {
      finishExtraFields.diffSummary = diff.summary;
      const diffPath = path.join(getActiveFluxDir(), `${id}.diff`);
      await fs.writeFile(diffPath, diff.fullDiff, 'utf-8');
    }
  } catch (err: unknown) {
    console.error(`Diff capture failed for ${id}:`, errorMessage(err));
  }

  const result = await updateTaskWithHistory(id, {
    entries: [{ type: 'comment', user: 'Agent', comment: completionComment, date: new Date().toISOString() }],
    updatedBy: 'Agent',
    nextStatus: 'Done',
    extraFields: finishExtraFields,
  }, req.workspace);
  if (!result) return res.status(500).json({ error: `Failed to finish ${id}` });

  // Reap any sessions still parked on an earlier phase now that the ticket is Done (FLUX-721 parity).
  const reaped = reapStaleParkedSessions(id, 'ticket finished → Done');
  if (reaped.length > 0) {
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`Reaped ${reaped.length} stale parked session${reaped.length > 1 ? 's' : ''} from an earlier phase on finish.`, 'Agent', new Date().toISOString())],
    }, req.workspace);
  }

  broadcastEvent('taskUpdated', { id });
  res.json({ finished: true, hash, link: hash });
});

export default router;
