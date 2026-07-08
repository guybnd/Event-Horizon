import type { FurnaceBatch, BatchTicket } from '../furnaceTypes';

/**
 * Reuses object identity for unchanged batches when merging a fresh `/api/furnace` poll result —
 * the Furnace-drawer analogue of `tasksEqual`'s board-side fix (FLUX-724). Every batch mutation
 * goes through `mutateFurnaceBatch` on the engine (furnace-store.ts), which unconditionally bumps
 * `updatedAt`, so `id` + `updatedAt` alone is a reliable per-batch version stamp — no field-by-field
 * diff needed. When nothing changed at all (an idle poll), returns `prev` itself so the caller's
 * `setState` bails out and the drawer produces zero re-renders (FLUX-1196).
 *
 * FLUX-1203: a changed batch still needs per-ticket identity reuse. `mutateFurnaceBatch`
 * `structuredClone`s the whole batch on every write, so a single-ticket transition hands back fresh
 * object references for EVERY ticket in `batch.tickets` — defeating `TicketRow`'s shallow-prop memo
 * and re-rendering all sibling rows. So when a batch's `updatedAt` bumps, we merge its tickets too,
 * keeping the old reference for any ticket that didn't actually change (unlike batches, tickets carry
 * no version stamp, so this needs a field-level compare — see `batchTicketsEqual`).
 */
export function mergeFurnaceBatches(prev: FurnaceBatch[], next: readonly FurnaceBatch[]): FurnaceBatch[] {
  const prevById = new Map(prev.map((b) => [b.id, b]));
  let changed = prev.length !== next.length;
  const merged = next.map((b) => {
    const old = prevById.get(b.id);
    if (old && old.updatedAt === b.updatedAt) return old;
    changed = true;
    if (!old) return b;
    const tickets = mergeBatchTickets(old.tickets, b.tickets);
    return tickets === b.tickets ? b : { ...b, tickets };
  });
  if (!changed) {
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== merged[i]) { changed = true; break; }
    }
  }
  return changed ? merged : prev;
}

/**
 * Merge a changed batch's ticket list, reusing the previous object reference for every ticket whose
 * fields are all unchanged. Returns `prev` unchanged (same array reference) when no ticket differs,
 * so a batch that changed only in batch-level fields keeps a stable `tickets` array too.
 */
function mergeBatchTickets(prev: BatchTicket[], next: BatchTicket[]): BatchTicket[] {
  const prevById = new Map(prev.map((t) => [t.ticketId, t]));
  let changed = prev.length !== next.length;
  const merged = next.map((t) => {
    const old = prevById.get(t.ticketId);
    if (old && batchTicketsEqual(old, t)) return old;
    changed = true;
    return t;
  });
  if (!changed) {
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== merged[i]) { changed = true; break; }
    }
  }
  return changed ? merged : prev;
}

/**
 * Field-level equality for two `BatchTicket`s. Tickets carry no `updatedAt`, and `structuredClone`
 * gives arrays (e.g. `sessionIds`) a fresh reference on every poll, so a plain `===` per field would
 * always report a change. Compares the union of keys, doing an element-wise compare for array-valued
 * fields (their elements are primitives) and `===` for everything else.
 */
function batchTicketsEqual(a: BatchTicket, b: BatchTicket): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (!Array.isArray(av) || !Array.isArray(bv) || av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}
