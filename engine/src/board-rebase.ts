import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { configCache } from './config.js';
import { getEnginePort } from './packaged-mode.js';
import { extractTicket } from './extract.js';
import { mergeTickets } from './merge.js';

/**
 * FLUX-659: the board-rebase ritual. The orchestrator proposes a BATCH of restructurings via
 * the `propose_board_rebase` MCP tool; this module parks the batch and broadcasts it
 * (`board-rebase-proposed`) — it NEVER mutates on its own. The portal renders a batch-approval
 * panel; the user approves a subset and POSTs to the resolve endpoint, which executes each
 * approved item through the VERB REGISTRY below and broadcasts the outcome (`board-rebase-resolved`).
 *
 * Sibling of FLUX-605's permission round-trip (permission-prompts.ts), with two deliberate
 * differences: it's a BATCH (many items, per-item approve/reject), and it's FIRE-THEN-RESOLVE
 * (the propose tool returns immediately; it does not block a tool call the way permission_prompt
 * holds the CLI open synchronously).
 *
 * "Propose, never silently restructure" (the ticket title) is enforced two ways: the proposal
 * path here (nothing applies without an explicit human approve), AND the FLUX-605 CONFIRM tier
 * gating the mutating verbs (extract_ticket/merge_tickets/archive_ticket/change_status) so a
 * direct call is still gated even if it bypasses the ritual.
 *
 * The registry is VERB-AGNOSTIC: the spine ships now with dispatch/status/archive/leave wired;
 * promote (FLUX-656 extract_ticket) and fold (FLUX-657 merge_tickets) depend on the substrate
 * turn-slicing (FLUX-658) and register their executor when they land — until then they no-op
 * with a clear "pending <ticket>" result so a proposal can still be made and approved.
 */

export type RebaseKind = 'promote' | 'fold' | 'archive' | 'dispatch' | 'status' | 'leave';

export interface RebaseItem {
  /** Per-item id assigned by the engine (the unit of approve/reject). */
  id: string;
  kind: RebaseKind;
  /** Ticket id(s) the item acts on. For `fold`, the source streams. */
  targets: string[];
  summary: string;
  rationale?: string;
  /** kind === 'status': target status. */
  newStatus?: string;
  /** kind === 'dispatch': phase to launch. */
  phase?: string;
  /** kind === 'fold': destination ticket the sources merge into. */
  into?: string;
  /** kind === 'promote' (FLUX-656): inclusive seq range of the topic-slice on the source
   *  stream (`targets[0]`, default `__board__`) to carve into a new card. */
  fromSeq?: number;
  toSeq?: number;
  /** kind === 'promote': title for the new card the slice seeds. */
  title?: string;
}

export interface PendingBatch {
  id: string;
  items: RebaseItem[];
  conversationId: string | null;
  createdAt: string;
}

export interface RebaseItemResult {
  id: string;
  kind: RebaseKind;
  ok: boolean;
  message: string;
}

const pending = new Map<string, PendingBatch>();

/** Park a proposed batch and broadcast it. Returns the assigned batch (with per-item ids). */
export function proposeBoardRebase(
  rawItems: Array<Omit<RebaseItem, 'id'>>,
  conversationId: string | null,
): PendingBatch {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const items: RebaseItem[] = rawItems.map((it) => ({ ...it, id: randomUUID() }));
  const batch: PendingBatch = { id, items, conversationId, createdAt };
  pending.set(id, batch);
  broadcastEvent('board-rebase-proposed', batch);
  return batch;
}

export function listPendingBoardRebases(): PendingBatch[] {
  return Array.from(pending.values());
}

/**
 * Apply the approved subset of a parked batch. Unapproved items are recorded as skipped;
 * approved items run through the verb registry. Always broadcasts `board-rebase-resolved`
 * (so any open panel clears) and returns the per-item results. Null if no such batch.
 */
export async function resolveBoardRebase(
  id: string,
  approvedItemIds: string[],
): Promise<{ ok: boolean; results: RebaseItemResult[] } | null> {
  const batch = pending.get(id);
  if (!batch) return null;
  pending.delete(id);

  const approved = new Set(approvedItemIds);
  const results: RebaseItemResult[] = [];
  for (const item of batch.items) {
    if (!approved.has(item.id)) {
      results.push({ id: item.id, kind: item.kind, ok: true, message: 'skipped (not approved)' });
      continue;
    }
    const exec = registry.get(item.kind);
    if (!exec) {
      results.push({ id: item.id, kind: item.kind, ok: false, message: `verb "${item.kind}" has no executor` });
      continue;
    }
    try {
      const r = await exec(item);
      results.push({ id: item.id, kind: item.kind, ok: r.ok, message: r.message });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: item.id, kind: item.kind, ok: false, message: message || 'executor threw' });
    }
  }

  broadcastEvent('board-rebase-resolved', { id, results });
  return { ok: true, results };
}

// ─── Verb registry ──────────────────────────────────────────────────────────
// kind → executor. Each verb (FLUX-656/657/616) plugs in one entry. v1 wires the verbs that
// exist; promote/fold no-op with a "pending" result until their tool lands.

export type VerbExecutor = (item: RebaseItem) => Promise<{ ok: boolean; message: string }>;

const registry = new Map<RebaseKind, VerbExecutor>();

/** Register (or replace) the executor for a verb. Called by 656/657 when they land. */
export function registerVerb(kind: RebaseKind, exec: VerbExecutor): void {
  registry.set(kind, exec);
}

function commentEntry(rationale?: string) {
  return rationale
    ? [{ type: 'comment', user: 'Agent', comment: rationale, date: new Date().toISOString() }]
    : [];
}

function registerDefaults(): void {
  // `leave` — the default-safe sink: keep the stream in the durable orchestrator thread.
  registerVerb('leave', async (item) => ({
    ok: true,
    message: `left ${item.targets.join(', ') || 'item'} in the orchestrator thread`,
  }));

  // `status` — move one ticket to a new status (the gated change_status, routed through approval).
  registerVerb('status', async (item) => {
    const ticketId = item.targets[0];
    if (!ticketId) return { ok: false, message: 'status: no target ticket' };
    if (!item.newStatus) return { ok: false, message: `status: no newStatus for ${ticketId}` };
    if (!tasksCache[ticketId]) return { ok: false, message: `status: ${ticketId} not found` };
    // FLUX-672: this executor writes through updateTaskWithHistory directly (the post-approval
    // path deliberately skips change_status's CONFIRM gate), but it must NOT skip the
    // comment-required rule. Mirror how change_status resolves the comment-required statuses
    // (Require Input + Ready/readyForMerge). If the target is one of them and the rationale is
    // blank, synthesize a minimal comment so the history entry the rule demands still exists.
    const requireInputStatus = configCache.requireInputStatus || 'Require Input';
    const readyStatus = configCache.readyForMergeStatus || 'Ready';
    const commentRequired = item.newStatus === requireInputStatus || item.newStatus === readyStatus;
    let entries = commentEntry(item.rationale);
    if (commentRequired && entries.length === 0) {
      entries = [{ type: 'comment', user: 'Agent', comment: `Moved to ${item.newStatus} via board-rebase.`, date: new Date().toISOString() }];
    }
    const result = await updateTaskWithHistory(ticketId, {
      entries,
      updatedBy: 'Agent',
      nextStatus: item.newStatus,
    });
    if (!result) return { ok: false, message: `status: failed to update ${ticketId}` };
    broadcastEvent('taskUpdated', { id: ticketId });
    return { ok: true, message: `${ticketId} → ${item.newStatus}` };
  });

  // `archive` — retire ticket(s) to the Archived status (FLUX-616's archive_ticket, which exists).
  registerVerb('archive', async (item) => {
    const archiveStatus = configCache.archiveStatus || 'Archived';
    // FLUX-672: a multi-target archive previously early-returned on the first failure, leaving
    // targets 1..N-1 already archived but reporting only the failure (silent partial state). Now
    // we run the whole loop, collect succeeded vs failed ids, and enumerate both in the message.
    // `ok` is true only when EVERY target succeeded; a single failure flips it false but the
    // message still names what actually changed (no rollback — archive is reversible via unarchive).
    const done: string[] = [];
    const failed: string[] = [];
    for (const ticketId of item.targets) {
      const task = tasksCache[ticketId];
      if (!task) { failed.push(`${ticketId} (not found)`); continue; }
      if (task.status === archiveStatus) { done.push(`${ticketId} (already)`); continue; }
      const extraFields: Record<string, unknown> = {};
      if (task.swimlane) extraFields.swimlane = null;
      const result = await updateTaskWithHistory(ticketId, {
        entries: commentEntry(item.rationale),
        updatedBy: 'Agent',
        nextStatus: archiveStatus,
        ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      });
      if (!result) { failed.push(`${ticketId} (update failed)`); continue; }
      broadcastEvent('taskUpdated', { id: ticketId });
      done.push(ticketId);
    }
    const parts: string[] = [];
    if (done.length > 0) parts.push(`archived ${done.join(', ')}`);
    if (failed.length > 0) parts.push(`failed ${failed.join(', ')}`);
    const message = parts.join('; ') || 'archive: no targets';
    return { ok: failed.length === 0, message };
  });

  // `dispatch` — start a phase session on a ticket (FLUX-606 start_session). Self-fetches the
  // engine's own start route so it reuses the full launch machinery (persona, branch, gating).
  registerVerb('dispatch', async (item) => {
    const ticketId = item.targets[0];
    if (!ticketId) return { ok: false, message: 'dispatch: no target ticket' };
    // FLUX-845: board-rebase dispatch is unattended and often launches several sessions in one
    // approved batch — isolate each in its own worktree by default so they never share a checkout
    // (the FLUX-840/841/844 tangle). The engine creates the branch+worktree before spawning.
    const body: Record<string, unknown> = { framework: 'claude', skipPermissions: true, patternPosition: 'standalone', isolation: 'worktree' };
    if (item.phase) body.phase = item.phase;
    try {
      const res = await fetch(`http://127.0.0.1:${getEnginePort()}/api/tasks/${ticketId}/cli-session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, message: `dispatch: ${e.error || res.statusText}` };
      }
      const r = (await res.json()) as { session?: { id?: string } };
      return { ok: true, message: `dispatched ${item.phase || 'phase'} session on ${ticketId} (${r.session?.id || 'session'})` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `dispatch: ${message || 'failed'}` };
    }
  });

  // `promote` (FLUX-656) — carve a topic-slice out of a stream into a new card. Shares the
  // engine `extractTicket()` with the `extract_ticket` MCP tool, so the slice→card path
  // exists once. `targets[0]` is the source stream (default `__board__`); `fromSeq`/`toSeq`
  // address the slice; `title` (or the item summary) names the new card. Additive + un-doable.
  registerVerb('promote', async (item) => {
    const from = item.targets[0] || '__board__';
    const title = item.title || item.summary;
    if (typeof item.fromSeq !== 'number' || typeof item.toSeq !== 'number') {
      return { ok: false, message: 'promote: fromSeq and toSeq are required to carve the slice' };
    }
    try {
      const r = await extractTicket({
        from,
        fromSeq: item.fromSeq,
        toSeq: item.toSeq,
        title,
        ...(item.rationale ? { body: item.rationale } : {}),
      });
      return { ok: true, message: `extracted ${r.id} (${r.turnsExtracted} turns from ${from})` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `promote: ${message || 'extract failed'}` };
    }
  });

  // `fold` (FLUX-657) — merge source streams into a survivor. Shares the engine `mergeTickets()`
  // with the `merge_tickets` MCP tool, so the fold→survivor path exists once. `targets` are the
  // source streams; `into` is the survivor. Additive + un-doable (sources tombstoned + archived,
  // never deleted).
  registerVerb('fold', async (item) => {
    if (!item.into) return { ok: false, message: 'fold: no `into` survivor ticket' };
    if (!item.targets || item.targets.length === 0) return { ok: false, message: 'fold: no source streams to fold' };
    try {
      const r = await mergeTickets({ into: item.into, from: item.targets });
      const failed = r.archiveFailures.length ? `; archive failed for ${r.archiveFailures.join(', ')}` : '';
      return {
        ok: r.archiveFailures.length === 0,
        message: `folded ${r.merged.join(', ')} into ${r.into} (${r.turnsFolded} turns)${failed}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `fold: ${message || 'merge failed'}` };
    }
  });
}

registerDefaults();
