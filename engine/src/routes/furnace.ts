// The Furnace — REST CRUD for batches (FLUX-1008 → FLUX-1053 batch redesign).
//
// Create/read/mutate/delete Furnace batches. Mounted at `/api/furnace` behind `requireWorkspace`
// (see index.ts). Ignition / stop semantics (slot guard, Stoker kick) live in `furnace-stoker.ts`.

import express from 'express';
import {
  ensureFurnaceLoaded,
  getFurnaceBatchesCache,
  getFurnaceBatch,
  createFurnaceBatch,
  updateFurnaceBatch,
  deleteFurnaceBatch,
  mutateFurnaceBatch,
  globalSlotsInUse,
  freeSlots,
  FURNACE_SLOT_CAP,
} from '../furnace-store.js';
import {
  newBatchTicket,
  isBatchActive,
  isTerminalTicketState,
  type BatchTicket,
  type BatchKind,
  type BatchTrigger,
} from '../models/furnace.js';
import {
  igniteBatch,
  stopBatch,
  reconcileBatch,
  refreshWorktreePool,
  retryTicket,
  resumeBatch,
  dismissTicketFlag,
  takeoverTicket,
  handBackTicket,
} from '../furnace-stoker.js';
import { tasksCache } from '../task-store.js';
import { mergePullRequest } from '../branch-manager.js';

/** Map a BatchControlResult error to an HTTP status: not-found → 404, no_slots → 409, else 409. */
function controlErrorStatus(error: string | undefined): number {
  if (error === 'Furnace batch not found' || error === 'Ticket not in batch') return 404;
  return 409;
}

const router = express.Router();

/** Coerce a create/update payload's tickets into proper BatchTicket[]. Accepts full `tickets` entries or a `ticketIds` list. */
function coerceTickets(body: any): BatchTicket[] | undefined {
  if (Array.isArray(body?.tickets) && body.tickets.every((t: any) => t && typeof t === 'object' && 'state' in t)) {
    return body.tickets as BatchTicket[];
  }
  const ids: unknown[] | undefined = Array.isArray(body?.ticketIds)
    ? body.ticketIds
    : Array.isArray(body?.tickets)
      ? body.tickets
      : undefined;
  if (ids) {
    return ids
      .filter((t): t is string => typeof t === 'string')
      .map((ticketId, i) => newBatchTicket(ticketId, i, tasksCache[ticketId]?.title));
  }
  return undefined;
}

function coerceKind(v: unknown): BatchKind | undefined {
  return v === 'sequential' || v === 'parallel' ? v : undefined;
}

function coerceTrigger(v: any): BatchTrigger | null | undefined {
  if (v === null) return null;
  if (v && (v.type === 'batch' || v.type === 'pr') && typeof v.ref === 'string') return { type: v.type, ref: v.ref };
  return undefined;
}

router.get('/', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    // FLUX-1066/1067: reconcile against ground truth on read so a poll reflects any ticket completed /
    // taken over outside the Furnace, and the slot count matches the real worktree pool.
    await refreshWorktreePool();
    for (const b of getFurnaceBatchesCache()) await reconcileBatch(b.id);
    let batches = getFurnaceBatchesCache();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status) batches = batches.filter((b) => b.status === status);
    res.json(batches);
  } catch {
    res.status(500).json({ error: 'Failed to load furnace batches' });
  }
});

/** Live worktree-slot usage — the portal slot bar polls / seeds off this. */
router.get('/slots', async (_req, res) => {
  try {
    await ensureFurnaceLoaded();
    await refreshWorktreePool(); // FLUX-1067: count from the real pool, not just Furnace burns.
    res.json({ used: globalSlotsInUse(), free: freeSlots(), max: FURNACE_SLOT_CAP });
  } catch {
    res.status(500).json({ error: 'Failed to read worktree slots' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    if (!getFurnaceBatch(req.params.id)) return res.status(404).json({ error: 'Furnace batch not found' });
    await reconcileBatch(req.params.id); // FLUX-1066: observe ground truth on read.
    const batch = getFurnaceBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Furnace batch not found' });
    res.json(batch);
  } catch {
    res.status(500).json({ error: 'Failed to load furnace batch' });
  }
});

router.post('/', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'Untitled batch';
    const kind = coerceKind(req.body?.kind);
    const tickets = coerceTickets(req.body);
    const trigger = coerceTrigger(req.body?.trigger) ?? undefined;
    const batch = await createFurnaceBatch({
      title,
      ...(kind ? { kind } : {}),
      ...(tickets ? { tickets } : {}),
      ...(Number.isFinite(req.body?.burnRate) ? { burnRate: req.body.burnRate } : {}),
      ...(trigger ? { trigger } : {}),
      ...(typeof req.body?.createdBy === 'string' ? { createdBy: req.body.createdBy } : {}),
    });
    res.status(201).json(batch);
  } catch {
    res.status(500).json({ error: 'Failed to create furnace batch' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    const existing = getFurnaceBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Furnace batch not found' });
    const tickets = coerceTickets(req.body);
    const kind = coerceKind(req.body?.kind);
    const trigger = coerceTrigger(req.body?.trigger);
    // NOTE: `status` is deliberately NOT patchable here — transitions go through ignite/stop, which
    // enforce the slot guard. `branch`/`kind` are ignored by the store unless the batch is a draft.
    const updated = await updateFurnaceBatch(req.params.id, {
      ...(typeof req.body?.title === 'string' ? { title: req.body.title } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof req.body?.branch === 'string' ? { branch: req.body.branch } : {}),
      ...(tickets ? { tickets } : {}),
      ...(Number.isFinite(req.body?.burnRate) ? { burnRate: req.body.burnRate } : {}),
      ...(trigger !== undefined ? { trigger } : {}),
    });
    if (!updated) return res.status(404).json({ error: 'Furnace batch not found' });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update furnace batch' });
  }
});

// Ignite a batch (draft -> burning) and start the Stoker. Fails 409 with `no_slots` when the worktree
// pool is full.
router.post('/:id/ignite', async (req, res) => {
  try {
    const r = await igniteBatch(req.params.id);
    if (!r.ok) {
      if (r.error === 'Furnace batch not found') return res.status(404).json({ error: r.error });
      if (r.error === 'no_slots') return res.status(409).json({ error: 'no_slots', used: r.used, max: r.max });
      return res.status(409).json({ error: r.error });
    }
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to ignite furnace batch' });
  }
});

// Stop a batch. Graceful drain by default; `?hard=true` (or JSON body { hard:true }) is an immediate cutoff.
router.post('/:id/stop', async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual stop';
    const hard = req.body?.hard === true || req.query.hard === 'true';
    const r = await stopBatch(req.params.id, reason, hard ? { hard: true } : {});
    if (!r.ok) return res.status(r.error === 'Furnace batch not found' ? 404 : 409).json({ error: r.error });
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to stop furnace batch' });
  }
});

// ── Recovery actions (FLUX-1066 §4) — retry / resume / dismiss / takeover / hand-back ─────────────

// Resume a halted (parked) or finished (done) batch → burning: reset the breaker, re-queue halt-skipped
// tickets, claim a slot. 409 `no_slots` when the worktree pool is full.
router.post('/:id/resume', async (req, res) => {
  try {
    const r = await resumeBatch(req.params.id);
    if (!r.ok) {
      if (r.error === 'no_slots') return res.status(409).json({ error: 'no_slots', used: r.used, max: r.max });
      return res.status(controlErrorStatus(r.error)).json({ error: r.error });
    }
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to resume furnace batch' });
  }
});

// Retry a single parked/failed ticket → reset to queued with a fresh attempt budget.
router.post('/:id/tickets/:ticketId/retry', async (req, res) => {
  try {
    const r = await retryTicket(req.params.id, req.params.ticketId);
    if (!r.ok) return res.status(controlErrorStatus(r.error)).json({ error: r.error });
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to retry ticket' });
  }
});

// Dismiss the Furnace-raised flag on a ticket without re-queuing ("I've got this"). Works on a done batch.
router.post('/:id/tickets/:ticketId/dismiss', async (req, res) => {
  try {
    const r = await dismissTicketFlag(req.params.id, req.params.ticketId);
    if (!r.ok) return res.status(controlErrorStatus(r.error)).json({ error: r.error });
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to dismiss ticket flag' });
  }
});

// Take over a ticket (owner → human): the Furnace yields — stops its session, never reclaims the worktree.
router.post('/:id/tickets/:ticketId/takeover', async (req, res) => {
  try {
    const r = await takeoverTicket(req.params.id, req.params.ticketId);
    if (!r.ok) return res.status(controlErrorStatus(r.error)).json({ error: r.error });
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to take over ticket' });
  }
});

// Hand a taken-over ticket back to the Furnace (owner → furnace): re-queue with a fresh attempt budget.
router.post('/:id/tickets/:ticketId/handback', async (req, res) => {
  try {
    const r = await handBackTicket(req.params.id, req.params.ticketId);
    if (!r.ok) return res.status(controlErrorStatus(r.error)).json({ error: r.error });
    res.json(r.batch);
  } catch {
    res.status(500).json({ error: 'Failed to hand ticket back to the Furnace' });
  }
});

// Merge a batch's PR(s). With `prBranch` in the body, merge just that PR; otherwise merge every
// `approved` PR in the batch. On success each merged PR's reviewState flips to `merged` — which also
// satisfies the trigger watcher, so a batch whose `trigger` points at this one can then auto-ignite.
router.post('/:id/merge', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    const batch = getFurnaceBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Furnace batch not found' });
    const prBranch = typeof req.body?.prBranch === 'string' ? req.body.prBranch : undefined;
    const targets = batch.prs.filter((p) => (prBranch ? p.branch === prBranch : p.reviewState === 'approved'));
    if (targets.length === 0) {
      return res.status(400).json({ error: prBranch ? `No PR on branch ${prBranch} in this batch.` : 'No approved PRs to merge.' });
    }
    const merged: string[] = [];
    const failed: Array<{ branch: string; error: string }> = [];
    for (const pr of targets) {
      try { await mergePullRequest(pr.branch); merged.push(pr.branch); }
      catch (e: any) { failed.push({ branch: pr.branch, error: e?.message || 'merge failed' }); }
    }
    const updated = await mutateFurnaceBatch(req.params.id, (draft) => {
      for (const p of draft.prs) if (merged.includes(p.branch)) p.reviewState = 'merged';
    });
    res.json({ batch: updated, merged, failed });
  } catch {
    res.status(500).json({ error: 'Failed to merge batch PR(s)' });
  }
});

// Append a single ticket to an existing batch (draft or burning). The Stoker picks up new queued
// tickets on its next tick. Rejects appending to a fully terminal batch.
router.post('/:id/ticket', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId.trim() : '';
    if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });

    const batch = getFurnaceBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Furnace batch not found' });
    // FLUX-1066: a `parked` (halted) batch is RESUMABLE, so allow queuing more work onto it before a
    // resume; only a cleanly-`done` batch is closed (make a new batch instead).
    if (batch.status === 'done') {
      return res.status(409).json({ error: 'Cannot append to a completed batch — create a new one.' });
    }
    if (batch.tickets.some((t) => t.ticketId === ticketId)) {
      return res.status(409).json({ error: `${ticketId} is already in this batch.` });
    }
    const maxOrder = batch.tickets.reduce((m, t) => Math.max(m, t.order), -1);
    const entry = newBatchTicket(ticketId, maxOrder + 1, tasksCache[ticketId]?.title);

    const updated = await mutateFurnaceBatch(req.params.id, (draft) => { draft.tickets.push(entry); });
    if (!updated) return res.status(404).json({ error: 'Furnace batch not found' });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to append ticket' });
  }
});

// Remove a ticket from a batch. Disallowed while burning (the worktree/branch is live) unless the
// ticket hasn't started yet (still queued).
router.delete('/:id/ticket/:ticketId', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    const batch = getFurnaceBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Furnace batch not found' });
    const t = batch.tickets.find((x) => x.ticketId === req.params.ticketId);
    if (!t) return res.status(404).json({ error: 'Ticket not in batch' });
    if (isBatchActive(batch.status) && !isTerminalTicketState(t.state) && t.state !== 'queued') {
      return res.status(409).json({ error: 'Cannot remove a ticket that is burning — stop the batch first.' });
    }
    const updated = await mutateFurnaceBatch(req.params.id, (draft) => {
      draft.tickets = draft.tickets.filter((x) => x.ticketId !== req.params.ticketId);
    });
    if (!updated) return res.status(404).json({ error: 'Furnace batch not found' });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to remove ticket' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    const batch = getFurnaceBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Furnace batch not found' });
    if (isBatchActive(batch.status)) {
      return res.status(409).json({ error: 'Cannot delete a batch that is burning — stop it first.' });
    }
    const ok = await deleteFurnaceBatch(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Furnace batch not found' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete furnace batch' });
  }
});

export default router;
