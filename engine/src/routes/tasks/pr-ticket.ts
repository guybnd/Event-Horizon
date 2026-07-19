// PR-card operations (FLUX-349 split): routes that act on `kind:'pr'` deck tickets —
// "Continue development" (adopt/create a member ticket) and "Retry" (fresh cycle on a
// merged/closed PR). Branch-scoped PR lifecycle routes live in pr.ts.
import express from 'express';
import { updateTaskWithHistory, upsertManagedTicket, createTask } from '../../task-store.js';
import { createTicketBranch } from '../../branch-manager.js';
import { broadcastEvent } from '../../events.js';
import { selectMembers } from '../../pr-tickets.js';
import { errorMessage, reqWorkspace } from './helpers.js';
import type { TaskRecord } from './helpers.js';

const router = express.Router();

// Continue development on a PR by binding work to its branch (FLUX-569 AC1). A zero-member PR
// ticket — e.g. a PR opened directly on GitHub with no EH ticket — has nothing holding its work,
// so "Continue development" offers two ways to give it a home that folds into the deck:
//  - mode 'adopt'  → rebind an EXISTING ticket to the PR's branch + move it to In Progress.
//  - mode 'create' → create a FRESH ticket bound to the branch (status In Progress).
// Either way the new member is work-gated In Progress on the branch, so it folds into the deck;
// we recompute + stamp the PR ticket's members immediately rather than wait for the 90s poll.
router.post('/:id/pr/adopt', async (req, res) => {
  const { id } = req.params;
  const pr = reqWorkspace(req).tasks[id] as TaskRecord;
  if (!pr) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (pr.kind !== 'pr') return res.status(409).json({ error: 'Adopt/create is only available for PR tickets.' });
  const branch: string | undefined = pr.branch ?? undefined;
  if (!branch) return res.status(409).json({ error: 'PR ticket has no branch to bind work to.' });

  const mode: string = (req.body?.mode ?? '').toString();
  const author: string = req.body?.updatedBy || 'Unknown';

  try {
    let memberId: string;
    if (mode === 'adopt') {
      const targetId: string = (req.body?.ticketId ?? '').toString().trim();
      const target = reqWorkspace(req).tasks[targetId] as TaskRecord;
      if (!target) return res.status(404).json({ error: `Ticket ${targetId} not found` });
      if (target.kind === 'pr') return res.status(409).json({ error: 'Cannot adopt a PR ticket into another PR.' });
      // Don't silently re-point a ticket that's already bound to a DIFFERENT branch (FLUX-569
      // lifecycle-edge safety): it's likely a live member of another PR, and rebinding would
      // orphan it from that PR and abandon committed work on its old branch. Same-branch adopt is
      // a harmless re-home (it just folds the ticket back in + re-activates it), so allow that.
      if (target.branch && target.branch !== branch) {
        return res.status(409).json({
          error: `Ticket ${targetId} is already bound to branch \`${target.branch}\` — adopting it into PR #${pr.prNumber} (\`${branch}\`) would orphan it from its existing PR and abandon committed work. Detach it from its current branch first, or create a new ticket instead.`,
        });
      }
      await updateTaskWithHistory(targetId, {
        updatedBy: author,
        entries: [{ type: 'comment', user: author, comment: `Adopted into PR #${pr.prNumber} — bound to branch \`${branch}\` to continue its work.`, date: new Date().toISOString() }],
        nextStatus: 'In Progress',
        extraFields: { branch, ...(target.implementationLink ? {} : { implementationLink: pr.implementationLink }) },
      }, req.workspace);
      memberId = targetId;
    } else if (mode === 'create') {
      const title: string = (req.body?.title ?? '').toString().trim();
      if (!title) return res.status(400).json({ error: 'A title is required to create a ticket.' });
      const reqBody = (req.body?.body ?? '').toString().trim();
      const { id: newId } = await createTask({
        title,
        status: 'In Progress',
        body: reqBody || `Continues the work in PR #${pr.prNumber}${pr.implementationLink ? ` ([link](${pr.implementationLink}))` : ''}.`,
        author,
        links: [{ type: 'continues', target: id, label: `PR #${pr.prNumber}` }],
      }, req.workspace);
      await updateTaskWithHistory(newId, { updatedBy: 'Agent', extraFields: { branch, implementationLink: pr.implementationLink } }, req.workspace);
      memberId = newId;
    } else {
      return res.status(400).json({ error: `Unknown mode "${mode}" — expected "adopt" or "create".` });
    }

    // Fold the new member into the PR deck immediately (don't wait for the 90s sync poll).
    const members = selectMembers(Object.values(reqWorkspace(req).tasks), branch);
    await upsertManagedTicket(id, { members }, '', req.workspace).catch(() => {});
    broadcastEvent('taskUpdated', { id });
    broadcastEvent('taskUpdated', { id: memberId });
    res.json({ memberId, members });
  } catch (err: unknown) {
    res.status(500).json({ error: `Adopt/create failed: ${errorMessage(err)}` });
  }
});

// Retry a merged/closed PR (FLUX-593): spawn a NEW ticket linked to the PR via a 'retries'
// relation, carrying the user's reason + the PR's context as agent launch-focus, optionally
// on a fresh branch. A merged PR is immutable — this is a fresh cycle, not an un-merge. The
// 'retries' link is the first instance of the typed-relationships model (epic FLUX-596).
router.post('/:id/retry', async (req, res) => {
  const { id } = req.params;
  const pr = reqWorkspace(req).tasks[id] as TaskRecord;
  if (!pr) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (pr.kind !== 'pr') return res.status(409).json({ error: 'Retry is only available for PR tickets.' });

  const reason: string = (req.body?.reason ?? '').toString().trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to retry a PR.' });
  const createBranch: boolean = req.body?.createBranch === true;
  const author: string = req.body?.updatedBy || 'Unknown';

  const prNum = pr.prNumber;
  const prUrl: string = pr.implementationLink || '';
  const baseTitle = (pr.title || `PR #${prNum}`).replace(/^PR #\d+:\s*/, ''); // drop "PR #n: " prefix
  const members: string[] = Array.isArray(pr.members) ? pr.members : [];
  const memberTask = members.map((m) => reqWorkspace(req).tasks[m]).find(Boolean) as TaskRecord | undefined;
  const tags: string[] = Array.isArray(memberTask?.tags) ? memberTask.tags : [];

  const stateWord = pr.prState === 'MERGED' ? 'merged' : pr.prState === 'CLOSED' ? 'was closed without merging' : 'is resolved';
  const body = [
    `## Retry of PR #${prNum}`,
    ``,
    `**PR #${prNum}**${prUrl ? ` ([link](${prUrl}))` : ''} ${stateWord}, but the work needs another pass.`,
    ``,
    `**Reason for retry (from ${author}):**`,
    `> ${reason.replace(/\n/g, '\n> ')}`,
    ``,
    members.length ? `**Original ticket(s):** ${members.join(', ')}` : `**Original ticket(s):** (none recorded)`,
    ``,
    `## How to continue`,
    `The original PR is settled and can't be re-opened, so this is a fresh cycle on a new branch. Review PR #${prNum}'s diff and the reason above, reproduce the problem, and continue from where that work left off — then open a new PR.`,
  ].join('\n');

  try {
    const { id: newId, task } = await createTask({
      title: `Retry PR #${prNum}: ${baseTitle}`,
      status: 'In Progress',
      ...(memberTask?.priority ? { priority: memberTask.priority } : {}),
      tags,
      body,
      author,
      links: [{ type: 'retries', target: id, label: `PR #${prNum}` }],
    }, req.workspace);

    let branch: string | undefined;
    if (createBranch) {
      try {
        branch = await createTicketBranch(newId, task.title || newId);
        await updateTaskWithHistory(newId, { updatedBy: 'Agent', extraFields: { branch } }, req.workspace);
      } catch (err: unknown) {
        // Best-effort — the ticket exists regardless; note why the branch didn't get created.
        await updateTaskWithHistory(newId, {
          updatedBy: 'Agent',
          entries: [{ type: 'comment', user: 'Agent', comment: `Retry branch could not be created automatically: ${errorMessage(err)}. Create one via Start.`, date: new Date().toISOString() }],
        }, req.workspace);
      }
    }
    broadcastEvent('taskUpdated', { id: newId });
    res.json({ id: newId, branch: branch ?? null });
  } catch (err: unknown) {
    res.status(500).json({ error: `Failed to create retry ticket: ${errorMessage(err)}` });
  }
});

export default router;
