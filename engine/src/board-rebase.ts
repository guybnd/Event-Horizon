import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { configCache } from './config.js';
import { getEnginePort } from './packaged-mode.js';

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
    } catch (err: any) {
      results.push({ id: item.id, kind: item.kind, ok: false, message: err?.message || 'executor threw' });
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
    const result = await updateTaskWithHistory(ticketId, {
      entries: commentEntry(item.rationale),
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
    const done: string[] = [];
    for (const ticketId of item.targets) {
      const task = tasksCache[ticketId];
      if (!task) return { ok: false, message: `archive: ${ticketId} not found` };
      if (task.status === archiveStatus) { done.push(`${ticketId} (already)`); continue; }
      const extraFields: Record<string, any> = {};
      if (task.swimlane) extraFields.swimlane = null;
      const result = await updateTaskWithHistory(ticketId, {
        entries: commentEntry(item.rationale),
        updatedBy: 'Agent',
        nextStatus: archiveStatus,
        ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      });
      if (!result) return { ok: false, message: `archive: failed to update ${ticketId}` };
      broadcastEvent('taskUpdated', { id: ticketId });
      done.push(ticketId);
    }
    return { ok: true, message: `archived ${done.join(', ')}` };
  });

  // `dispatch` — start a phase session on a ticket (FLUX-606 start_session). Self-fetches the
  // engine's own start route so it reuses the full launch machinery (persona, branch, gating).
  registerVerb('dispatch', async (item) => {
    const ticketId = item.targets[0];
    if (!ticketId) return { ok: false, message: 'dispatch: no target ticket' };
    const body: Record<string, unknown> = { framework: 'claude', skipPermissions: true, patternPosition: 'standalone' };
    if (item.phase) body.phase = item.phase;
    try {
      const res = await fetch(`http://127.0.0.1:${getEnginePort()}/api/tasks/${ticketId}/cli-session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e: any = await res.json().catch(() => ({}));
        return { ok: false, message: `dispatch: ${e.error || res.statusText}` };
      }
      const r: any = await res.json();
      return { ok: true, message: `dispatched ${item.phase || 'phase'} session on ${ticketId} (${r.session?.id || 'session'})` };
    } catch (err: any) {
      return { ok: false, message: `dispatch: ${err?.message || 'failed'}` };
    }
  });

  // Pending verbs — proposable and approvable now; the executor registers when the verb lands.
  // Replaced by registerVerb('promote'/'fold', …) from FLUX-656 / FLUX-657 (turn slicing rests
  // on the FLUX-658 substrate). Until then, applying such an item is a clear no-op, never a crash.
  registerVerb('promote', async () => ({
    ok: false,
    message: 'promote pending — extract_ticket (FLUX-656) not yet built',
  }));
  registerVerb('fold', async () => ({
    ok: false,
    message: 'fold pending — merge_tickets (FLUX-657) not yet built',
  }));
}

registerDefaults();
