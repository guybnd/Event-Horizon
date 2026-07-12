// The Furnace — REST CRUD for batches (FLUX-1008 → FLUX-1053 batch redesign).
//
// Create/read/mutate/delete Furnace batches. Mounted at `/api/furnace` behind `requireWorkspace`
// (see index.ts). Ignition / stop semantics (slot guard, Stoker kick) live in `furnace-stoker.ts`.

import { getWorkspace } from '../workspace-context.js';
import express from 'express';
import { log } from '../log.js';
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
  validateBatchTrigger,
  type BatchTicket,
  type BatchKind,
  type BatchTrigger,
} from '../models/furnace.js';
import {
  igniteBatch,
  stopBatch,
  reconcileBatchCached,
  reconcileAllBatchesCached,
  refreshWorktreePool,
  hasScannedWorktreePool,
  retryTicket,
  resumeBatch,
  dismissTicketFlag,
  takeoverTicket,
  handBackTicket,
  isDispatching,
  clearTakeoverTracking,
  evictReconcileReadCache,
} from '../furnace-stoker.js';
import { validateBatchTickets, type RejectedBatchTicket } from '../furnace-builder.js';

import { mergePullRequest } from '../branch-manager.js';

/** Map a BatchControlResult error to an HTTP status: not-found → 404, no_slots → 409, else 409. */
function controlErrorStatus(error: string | undefined): number {
  if (error === 'Furnace batch not found' || error === 'Ticket not in batch') return 404;
  return 409;
}

/**
 * Fire a background refresh without the caller awaiting it (FLUX-1185) — `run` is already TTL-gated
 * and single-flighted (`refreshWorktreePool`, `reconcileBatchCached`/`reconcileAllBatchesCached`), so
 * this just stops a GET response from blocking on it. Log-and-swallow: a failed pass must never 500 a
 * read that already has a perfectly good (if slightly stale) cached value to serve.
 */
function backgroundRefresh(label: string, run: () => Promise<void>): void {
  void run().catch((err: unknown) => {
    log.warn(`[furnace] background ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Refresh the observed worktree pool, blocking ONLY on the very first scan since boot (FLUX-1187).
 * `globalSlotsInUse()`/`freeSlots()` derive from `observedWorktreeCount`, which — unlike the batch
 * cache — has no on-disk source of truth: it starts at 0 until a real `git worktree list` scan
 * completes. A purely background-fired first call (the FLUX-1185 SWR treatment) would answer that
 * very first request with a stale/inflated slot count. Every call after the first behaves exactly like
 * `backgroundRefresh` above — fire-and-forget, answering from whatever pool state is already cached.
 */
async function refreshWorktreePoolMaybeBlocking(): Promise<void> {
  if (!hasScannedWorktreePool()) {
    await refreshWorktreePool().catch((err: unknown) => {
      log.warn(`[furnace] initial worktree pool scan failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  backgroundRefresh('worktree pool refresh', () => refreshWorktreePool());
}

const router = express.Router();

/**
 * Resolve a create/update payload's tickets into `BatchTicket[]`, validating any explicitly-listed ids
 * against existence + allowed status + the one-active-batch invariant (FLUX-1029, FLUX-1051). A full
 * `tickets` array (objects already carrying a `state`) is already-constructed curated state and is meant
 * as a re-sequencing path — only re-ordering the batch's own tickets, never introducing new ones — so
 * entries whose id is already in `opts.currentTicketIds` pass through unvalidated; any entry naming an id
 * NOT already in the batch (FLUX-1103: e.g. a brand-new id smuggled into the full-object array) is
 * validated the same as the id-list path below. Passing that gate only proves the id is eligible to
 * join a batch — it says nothing about the rest of the client-supplied object, so (FLUX-1111) a
 * newly-validated entry is rebuilt via `newBatchTicket` (safe defaults: `state: 'queued'`, `attempts: 0`,
 * no `sessionIds`/`prUrl`/`owner`/`currentSessionId`), keeping only the client's requested `order` and the
 * real ticket title — a forged `state`/`attempts`/`prUrl`/`owner` on a brand-new id can never ride along.
 * A `ticketIds` / string `tickets` list is hand-supplied and IS always validated. Returns:
 *   - `{}` when the body carries no tickets (leave the batch's tickets untouched)
 *   - `{ tickets }` when resolved
 *   - `{ rejected }` when one or more ids are unknown / bad-status / already active
 *     elsewhere (caller responds 400)
 *
 * `excludeBatchId` should be the batch being updated (PUT) so re-saving its own tickets never
 * self-conflicts; omit it for a fresh create (POST), where every existing batch counts.
 * `currentTicketIds` should be the batch's ticket ids *before* this update (PUT only) — omit for POST,
 * where the batch has no prior tickets and every full-object id counts as new.
 */
export function resolveTickets(
  body: { tickets?: unknown; ticketIds?: unknown[]; [key: string]: unknown },
  opts: { excludeBatchId?: string; currentTicketIds?: string[] } = {},
): { tickets?: BatchTicket[]; rejected?: RejectedBatchTicket[] } {
  if (Array.isArray(body?.tickets) && body.tickets.every((t: unknown) => t !== null && typeof t === 'object' && 'state' in t)) {
    const fullTickets = body.tickets as BatchTicket[];
    const currentIds = new Set(opts.currentTicketIds ?? []);
    const newIds = fullTickets.filter((t) => !currentIds.has(t.ticketId)).map((t) => t.ticketId);
    if (!newIds.length) return { tickets: fullTickets };
    const { rejected } = validateBatchTickets(newIds, getWorkspace().tasks, {
      activeBatches: getFurnaceBatchesCache(),
      ...(opts.excludeBatchId ? { excludeBatchId: opts.excludeBatchId } : {}),
    });
    if (rejected.length) return { rejected };
    // The gate above only proves each new id is eligible — rebuild those entries from scratch so a
    // forged state/attempts/sessionIds/prUrl/owner on a brand-new id can never ride along (FLUX-1111).
    const newIdSet = new Set(newIds);
    const tickets = fullTickets.map((t) =>
      newIdSet.has(t.ticketId) ? newBatchTicket(t.ticketId, t.order, getWorkspace().tasks[t.ticketId]?.title) : t,
    );
    return { tickets };
  }
  const rawIds: unknown[] | undefined = Array.isArray(body?.ticketIds)
    ? body.ticketIds
    : Array.isArray(body?.tickets)
      ? body.tickets
      : undefined;
  if (!rawIds) return {};
  const ids = rawIds.filter((t): t is string => typeof t === 'string');
  const { ok, rejected } = validateBatchTickets(ids, getWorkspace().tasks, {
    activeBatches: getFurnaceBatchesCache(),
    ...(opts.excludeBatchId ? { excludeBatchId: opts.excludeBatchId } : {}),
  });
  if (rejected.length) return { rejected };
  return { tickets: ok };
}

/** 400 response for one or more ineligible ticket ids (unknown / bad-status / already active elsewhere). */
function rejectTickets(res: express.Response, rejected: RejectedBatchTicket[]) {
  return res.status(400).json({
    error: 'One or more tickets cannot be added to a batch (unknown id, not in an allowed status, or already queued in another batch).',
    rejected,
  });
}

export function coerceKind(v: unknown): BatchKind | undefined {
  return v === 'sequential' || v === 'parallel' ? v : undefined;
}

function coerceTrigger(v: unknown): BatchTrigger | null | undefined {
  if (v === null) return null;
  if (v && typeof v === 'object' && 'type' in v && 'ref' in v) {
    const rec = v as { type: unknown; ref: unknown };
    if ((rec.type === 'batch' || rec.type === 'pr') && typeof rec.ref === 'string') {
      return { type: rec.type, ref: rec.ref };
    }
  }
  return undefined;
}

router.get('/', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    // FLUX-1066/1067: reconcile against ground truth so a poll reflects any ticket completed / taken
    // over outside the Furnace, and the slot count matches the real worktree pool. FLUX-1145 TTL-gated +
    // single-flighted these, but the portal polls every ~3s against a ~3s/1.5s TTL — close enough that
    // almost every poll still landed past expiry and blocked on the full pass (694-906ms, FLUX-1185).
    // Stale-while-revalidate: answer from the already-loaded batch cache INSTANTLY and let the refresh
    // run in the background for the next read — `getFurnaceBatchesCache()` already reflects whatever the
    // last reconcile (this background pass, or the 5s drive-cycle tick) last observed, so there is always
    // a value to serve. The worktree-pool-derived slot count has no such on-disk backing (FLUX-1187), so
    // it still takes the first-call-blocks exception `tasks.ts`'s SWR memo has — see
    // `refreshWorktreePoolMaybeBlocking`.
    await refreshWorktreePoolMaybeBlocking();
    backgroundRefresh('batch reconcile', () => reconcileAllBatchesCached());
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
    // FLUX-1185: SWR, same as GET / above — count from whatever pool state is already cached and
    // refresh in the background rather than blocking this response on `git worktree list`. FLUX-1187:
    // except on the very first call since boot, when there's no cached pool state yet to serve.
    await refreshWorktreePoolMaybeBlocking();
    res.json({ used: globalSlotsInUse(), free: freeSlots(), max: FURNACE_SLOT_CAP });
  } catch {
    res.status(500).json({ error: 'Failed to read worktree slots' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    await ensureFurnaceLoaded();
    if (!getFurnaceBatch(req.params.id)) return res.status(404).json({ error: 'Furnace batch not found' });
    // FLUX-1066/1185: observe ground truth in the background (TTL-gated) rather than blocking on it —
    // same SWR reasoning as GET / above.
    backgroundRefresh('batch reconcile', () => reconcileBatchCached(req.params.id));
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
    const resolved = resolveTickets(req.body);
    if (resolved.rejected) return rejectTickets(res, resolved.rejected);
    const tickets = resolved.tickets;
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
    const resolved = resolveTickets(req.body, {
      excludeBatchId: req.params.id,
      currentTicketIds: existing.tickets.map((t) => t.ticketId),
    });
    if (resolved.rejected) return rejectTickets(res, resolved.rejected);
    const tickets = resolved.tickets;
    const kind = coerceKind(req.body?.kind);
    const trigger = coerceTrigger(req.body?.trigger);
    if (trigger) {
      const err = validateBatchTrigger(req.params.id, trigger, getFurnaceBatchesCache());
      if (err) return res.status(400).json({ error: err });
    }
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
      if (r.error === 'no_slots') return res.status(409).json({ error: 'no_slots', used: r.used, max: r.max, holders: r.holders });
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
      if (r.error === 'no_slots') return res.status(409).json({ error: 'no_slots', used: r.used, max: r.max, holders: r.holders });
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
      catch (e) { failed.push({ branch: pr.branch, error: (e as Error)?.message || 'merge failed' }); }
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
    const { rejected } = validateBatchTickets([ticketId], getWorkspace().tasks, {
      activeBatches: getFurnaceBatchesCache(),
      excludeBatchId: batch.id,
    });
    if (rejected.length) {
      const r = rejected[0];
      if (r?.reason === 'already-active') {
        return res.status(409).json({ error: `${ticketId} is already queued in batch ${r.batchId} — remove it there first.`, rejected });
      }
      return rejectTickets(res, rejected);
    }
    const maxOrder = batch.tickets.reduce((m, t) => Math.max(m, t.order), -1);
    const entry = newBatchTicket(ticketId, maxOrder + 1, getWorkspace().tasks[ticketId]?.title);

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
    // FLUX-1095: `t.state` stays `queued` until the freshly-dispatched session is recorded, so the
    // `queued` exemption above would otherwise let a removal race a spawn already in flight and orphan
    // the session (no batch left to own it). Reject and let the caller retry — the window is brief.
    if (isDispatching(req.params.ticketId)) {
      return res.status(409).json({ error: 'Cannot remove this ticket: a session spawn is in flight for it — try again in a moment.' });
    }
    const updated = await mutateFurnaceBatch(req.params.id, (draft) => {
      draft.tickets = draft.tickets.filter((x) => x.ticketId !== req.params.ticketId);
    });
    if (!updated) return res.status(404).json({ error: 'Furnace batch not found' });
    clearTakeoverTracking(req.params.ticketId); // FLUX-1094: don't leak debounce state past batch membership
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
    for (const t of batch.tickets) clearTakeoverTracking(t.ticketId); // FLUX-1094
    evictReconcileReadCache(req.params.id); // FLUX-1166
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete furnace batch' });
  }
});

export default router;
