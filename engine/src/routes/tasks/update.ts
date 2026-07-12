// The task update path (FLUX-349 split): PUT /:id. Split out of crud.ts on its own because it is
// the REST twin of MCP's update_ticket/change_status — the comment gates, schema validation and
// tag auto-registration all route through the FLUX-1044 shared status-transition service, and this
// handler is where that seam lives on the REST side.
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';
import { getConfig } from '../../config.js';
import {
  normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry,
  summarizeFieldChanges, findEarliestHistoryDate,
  reconcileNovelHistoryEntries,
} from '../../history.js';
import { serializeTaskForApi, updateTaskWithHistory, syncParentSubtaskLinks, validateParentLink, subtaskIds } from '../../task-store.js';
// FLUX-1044: the status-transition rulebook shared with the MCP tools — comment gates and the
// schema-validation + tag-registration sequencing live there (one seam for both write paths).
import { evaluateCommentGate, resolveTransitionStatusNames, validateAndRegisterTicketWrite } from '../../status-transition-service.js';
import { stopAllSessionsForTask } from '../../session-store.js';
import { broadcastEvent } from '../../events.js';
import type { HistoryEntry } from './helpers.js';

const router = express.Router();

router.put('/:id', async (req, res) => {
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const { id } = req.params;
  const { updatedBy, ...updates } = req.body;
  const task = getWorkspace().tasks[id];

  if (!task) return res.status(404).json({ error: 'Task not found' });

  const actor = updatedBy || task.updatedBy || 'Unknown';

  const appendHistoryEntries: HistoryEntry[] = Array.isArray(updates.appendHistory) ? updates.appendHistory : [];
  delete updates.appendHistory;

  // FLUX-847: portal-only override for the session "don't ask again" skip. Never persisted to
  // frontmatter (deleted below, mirroring appendHistory/requireInput). Relaxes ONLY the
  // config-gated Ready comment check further down — must never touch the Require Input check,
  // whose comment is the question being asked (a hard engine invariant).
  const skipCommentRequirement = updates.skipCommentRequirement === true;
  delete updates.skipCommentRequirement;

  if (updates.requireInput === true) {
    // Backwards-compat: requireInput flag now sets swimlane instead of changing status
    updates.swimlane = 'require-input';
    delete updates.requireInput;
    delete updates.status; // Don't change status — swimlane keeps ticket in place
    appendHistoryEntries.push({ type: 'swimlane_change', swimlane: 'require-input', action: 'set', user: actor });
  }

  // FLUX-1044: status names + the comment-requirement decisions below are shared with MCP's
  // `change_status` via the status-transition service — one rulebook, per-protocol formatting.
  const { requireInputStatus, readyStatus } = resolveTransitionStatusNames(getConfig());
  // Backwards-compat: portal drag to "Require Input" column routes through swimlane
  if (updates.status === requireInputStatus && task.status !== requireInputStatus) {
    const submittedHistory: HistoryEntry[] = Array.isArray(updates.history) ? updates.history : [];
    // FLUX-1308: skip reconciliation when no history array was submitted — building identity
    // signatures for the whole existing history is wasted work in the appendHistory-only case.
    const novelSubmitted = Array.isArray(updates.history)
      ? reconcileNovelHistoryEntries(task.history || [], submittedHistory)
      : [];
    const hasNewComment =
      novelSubmitted.some((e) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === requireInputStatus && e?.comment))) ||
      appendHistoryEntries.some((e) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === requireInputStatus && e?.comment)));
    const gate = evaluateCommentGate({
      currentStatus: task.status,
      newStatus: updates.status,
      hasComment: hasNewComment,
      requireInputStatus,
      readyStatus,
      requireCommentOnStatusChange: getConfig().requireCommentOnStatusChange,
    });
    if (gate.refuse) {
      return res.status(400).json({
        error: 'REQUIRE_INPUT_MISSING_COMMENT',
        message: 'Transitioning to Require Input requires a question comment in the same request.',
      });
    }
    // Route through swimlane: keep current status, set swimlane
    updates.swimlane = 'require-input';
    delete updates.status;
    appendHistoryEntries.push({ type: 'swimlane_change', swimlane: 'require-input', action: 'set', user: actor });
  }

  // When status changes away from a swimlane'd state, auto-clear the swimlane
  if (updates.status && task.swimlane && updates.status !== requireInputStatus) {
    appendHistoryEntries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: actor });
    updates.swimlane = null;
  }

  // FLUX-730/FLUX-731: INTENTIONAL asymmetry — unlike the MCP `change_status` path, this PUT
  // route does NOT enforce commit-before-Ready for worktree branches. Dragging a card to Ready
  // in the portal is a deliberate human action (the human can see the board and choose to move
  // it), distinct from the silent agent failure FLUX-730 targets (an agent reaching Ready with
  // uncommitted worktree work and no PR ever opening). PR creation here is still guarded
  // separately by the Raise-PR route (`POST /:id/pr`), which refuses aheadCount===0 — so a
  // drag-to-Ready with no commits cannot silently open an empty PR either. If this ever needs to
  // refuse, reuse `evaluateWorktreeReadyRefusal` from status-transition-service.ts rather than
  // duplicating it.
  if (updates.status === readyStatus && task.status !== readyStatus) {
    const submittedHistory: HistoryEntry[] = Array.isArray(updates.history) ? updates.history : [];
    // FLUX-1308: skip reconciliation when no history array was submitted — building identity
    // signatures for the whole existing history is wasted work in the appendHistory-only case.
    const novelSubmitted = Array.isArray(updates.history)
      ? reconcileNovelHistoryEntries(task.history || [], submittedHistory)
      : [];
    const hasNewComment =
      novelSubmitted.some((e) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment))) ||
      appendHistoryEntries.some((e) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment)));
    const gate = evaluateCommentGate({
      currentStatus: task.status,
      newStatus: updates.status,
      hasComment: hasNewComment,
      requireInputStatus,
      readyStatus,
      requireCommentOnStatusChange: getConfig().requireCommentOnStatusChange,
      skipCommentRequirement,
    });
    if (gate.refuse) {
      return res.status(400).json({
        error: 'READY_MISSING_COMMENT',
        message: 'Transitioning to Ready requires a completion comment in the same request.',
      });
    }

    // Auto-stop all CLI sessions when ticket moves to Ready
    stopAllSessionsForTask(id, `ticket moved to ${readyStatus}`);
  }

  // ── Build the history entries this PUT appends ─────────────────────────────
  // FLUX-1044: the write itself now routes through task-store.ts's `updateTaskWithHistory` —
  // the same FLUX-645-locked, atomic write + history + notification path MCP's
  // `update_ticket`/`change_status` use — instead of a hand-rolled read-modify-write that
  // bypassed the per-ticket serialization lock and could clobber a concurrent MCP append.
  // This handler now only computes WHAT to append/change; the helper owns the read-under-lock,
  // status_change/needsAction bookkeeping, notification dispatch, and cache update.
  const normalizedExistingHistory = normalizeHistoryEntries(task.history || []);
  const existingHistory = ensureCreationActivity(
    normalizedExistingHistory.history,
    task.createdBy || actor,
    findEarliestHistoryDate(normalizedExistingHistory.history),
  ).history;
  const { body, _path: _mergedPath, id: _mergedId, history: _mergedHistory, ...mergedFrontmatter } = { ...task, ...updates };
  if (updatedBy) {
    mergedFrontmatter.updatedBy = updatedBy;
  }

  const activityTimestamp = new Date().toISOString();
  const entriesToAppend: Record<string, unknown>[] = [];
  // FLUX-1308: reconcile by entry identity, not array length/position — a client submitting a
  // full `history` array from a stale snapshot (missing N entries the server already has) used
  // to have its first N genuinely-novel entries silently dropped by the old slice-by-length
  // reconciliation. See reconcileNovelHistoryEntries for the full rationale. Skipped entirely
  // when no `history` array was submitted (the dominant appendHistory-only case), which would
  // always yield [] but still pay to build identity signatures for the whole history.
  if (Array.isArray(updates.history)) {
    let submittedNormalized = normalizeHistoryEntries(updates.history).history;
    submittedNormalized = ensureCreationActivity(
      submittedNormalized,
      task.createdBy || actor,
      findEarliestHistoryDate(existingHistory),
    ).history;
    for (const entry of reconcileNovelHistoryEntries(existingHistory, submittedNormalized)) {
      entriesToAppend.push({ ...entry, date: activityTimestamp });
    }
  }

  const fieldChangeMessages = summarizeFieldChanges(task, mergedFrontmatter, body);
  if (fieldChangeMessages.length > 0) {
    entriesToAppend.push(buildActivityEntry(fieldChangeMessages.join(' '), actor, activityTimestamp));
  }

  // FLUX-725: the portal status-move writers send the `status_change` (with its required
  // comment) as `appendHistory` deltas. The fallback status_change for a move these entries
  // don't already record is appended by `updateTaskWithHistory` itself (keyed on `nextStatus`),
  // which skips its auto-entry when a matching one is present here — so a portal move never
  // gets a second, comment-less duplicate (previously the appendHasStatusChange /
  // hasAppendedStatusChange checks in this handler).
  for (const entry of appendHistoryEntries) {
    entriesToAppend.push({ ...entry, date: activityTimestamp });
  }

  // Bidirectional parentId sync — validate the link BEFORE any write. FLUX-1068: reject
  // self-parenting / cycles (shared with MCP update_ticket, which checks in this same order:
  // parent link first, then schema + tags via the shared service).
  const oldParentId = task.parentId || null;
  const newParentId = mergedFrontmatter.parentId !== undefined ? (mergedFrontmatter.parentId || null) : oldParentId;
  if (newParentId !== oldParentId) {
    const linkError = validateParentLink(id, newParentId);
    if (linkError) {
      return res.status(400).json({ error: 'INVALID_PARENT_LINK', message: linkError });
    }
  }

  // FLUX-1044: pre-write schema validation + tag auto-registration through the shared
  // status-transition service (same seam MCP update_ticket uses). Validated against the
  // prospective merge; the authoritative write below re-reads + re-applies under the
  // per-ticket lock. The engine's own fallback status_change entry (appended by the helper)
  // is trusted-by-construction, matching MCP change_status which never validates its own
  // engine-built entries.
  const prospective = {
    ...mergedFrontmatter,
    history: normalizeHistoryEntries([...existingHistory, ...entriesToAppend]).history,
  };
  const writeCheck = await validateAndRegisterTicketWrite(prospective, mergedFrontmatter.tags);
  if (!writeCheck.ok) {
    return res.status(400).json({
      error: 'SCHEMA_VALIDATION_FAILED',
      message: `Ticket schema validation failed:\n${writeCheck.message}`,
      details: writeCheck.errors,
    });
  }

  // Everything except the fields with a dedicated updateTaskWithHistory channel flows through
  // extraFields (the helper strips id/title/history/_path itself). Status only ever moves via
  // `nextStatus` — never extraFields — so the helper's status_change/needsAction/notification
  // bookkeeping stays authoritative.
  const statusChanging = typeof updates.status === 'string' && updates.status !== task.status;
  const {
    status: _updStatus, history: _updHistory, body: _updBody, title: _updTitle, parentId: _updParentId,
    ...restUpdates
  } = updates;
  const extraFields: Record<string, unknown> = { ...restUpdates };
  if (newParentId) {
    extraFields.parentId = newParentId;
  }
  // FLUX-1068: detach by deleting the key (not persisting `parentId: null`) — a no-op delete
  // when the ticket never had a parent.
  const deleteFields: string[] = newParentId ? [] : ['parentId'];

  try {
    const result = await updateTaskWithHistory(id, {
      entries: entriesToAppend,
      updatedBy: actor,
      ...(statusChanging ? { nextStatus: updates.status } : {}),
      ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      ...(deleteFields.length > 0 ? { deleteFields } : {}),
      ...(updates.title !== undefined ? { newTitle: updates.title } : {}),
      ...(updates.body !== undefined ? { newBody: updates.body } : {}),
    });
    if (!result) {
      return res.status(500).json({ error: 'Failed to save task' });
    }

    // FLUX-1068: bidirectional parentId ⇄ subtasks reconciliation now lives in one shared helper
    // (task-store.ts) that both this route and the MCP update_ticket tool call.
    await syncParentSubtaskLinks({
      id,
      oldParentId,
      newParentId,
      oldSubtasks: subtaskIds(task.subtasks),
      newSubtasks: subtaskIds(mergedFrontmatter.subtasks),
      actor,
    });

    broadcastEvent('taskUpdated', { id });
    res.json(serializeTaskForApi(getWorkspace().tasks[id]));
  } catch (err) {
    console.error('Failed to update task:', err);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

export default router;
