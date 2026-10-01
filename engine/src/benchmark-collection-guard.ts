/**
 * @file benchmark-collection-guard.ts
 *
 * FLUX-1739: a TTL-bounded in-memory registry marking a benchmark run's worktree as "still being
 * measured", so the reclaimer cannot delete it out from under evidence collection.
 *
 * WHY THIS EXISTS. `worktreeUnreclaimableReason` returns `null` — reclaimable — as soon as a ticket
 * sits at Ready or terminal with no live session on its branch. A benchmark run enters exactly that
 * state the moment its session ends, which is precisely when the runner reads its diff, runs
 * validation against the restored tree, and extracts friction. Two paths race it there:
 *   • the ~90s reconcile sweep, and
 *   • another run of the SAME suite hitting the worktree cap, whose `reclaimOnCapAndRetry` backstop
 *     runs with `honorReadyGrace: false` and so deliberately bypasses `READY_WORKTREE_GRACE_MS`.
 * At the default concurrency that second path is the NORMAL case, not an edge: run B would delete
 * run A's worktree during A's own validation, scoring a solved run `unsolved` or empty-diff.
 *
 * WHY THE WINDOW OPENS BEFORE DISPATCH, not when collection starts. The runner does not regain
 * control at the instant the run's session ends — the gap between "session ended" and "runner
 * resumes" is unowned, and both reclaim paths are live in it. So the window must already be open
 * before the agent is ever dispatched.
 *
 * WHY NO IMPORTS. `pr-cleanup.ts` queries this module, and `pr-cleanup.ts` is itself reachable from
 * the session/adapter layer. `background-process-holds.ts` states the same constraint in its own
 * header — it must "never need to import task-store.ts and risk an import cycle with the
 * adapters/session-store that in turn need to query holds". (That module is not itself import-free;
 * the property copied here is the absence of the cycle, not an absence of imports. This one happens
 * to need nothing at all.)
 *
 * WHY NO PERSISTENCE, unlike a hold. A hold protects a process that must outlive a session. This
 * protects a measurement in flight — and a suite that does not survive an engine restart has already
 * lost the run it was protecting, so there is nothing for a persisted entry to come back to.
 *
 * WHY A TTL. Same reason a hold has one: a crashed runner must not protect a slot forever. The TTL
 * covers the WHOLE session (not just collection), because the window opens before dispatch — so it
 * is sized from the suite's per-run wall-clock budget, and {@link refreshCollection} extends it on
 * an observed heartbeat so a long-but-live run is never evicted mid-flight.
 */

/** Fallback TTL when a caller does not supply one — deliberately generous; the runner passes its own. */
export const DEFAULT_COLLECTION_TTL_MS = 60 * 60_000;

interface CollectionEntry {
  ticketId: string;
  expiresAt: number;
  startedAt: number;
}

const collecting = new Map<string, CollectionEntry>();

/**
 * Open the protection window for a run. Called immediately after the run's worktree is created and
 * BEFORE its agent is dispatched. Idempotent: re-calling refreshes the deadline.
 */
export function beginCollection(ticketId: string, ttlMs: number = DEFAULT_COLLECTION_TTL_MS): void {
  if (!ticketId) return;
  const now = Date.now();
  collecting.set(ticketId, { ticketId, startedAt: now, expiresAt: now + Math.max(1, ttlMs) });
}

/** Extend the deadline for a run still observably alive. No-op if the window is already closed. */
export function refreshCollection(ticketId: string, ttlMs: number = DEFAULT_COLLECTION_TTL_MS): void {
  const entry = collecting.get(ticketId);
  if (!entry) return;
  entry.expiresAt = Date.now() + Math.max(1, ttlMs);
}

/** Close the window. Always call this from a `finally` — the TTL is a backstop, not the mechanism. */
export function endCollection(ticketId: string): void {
  collecting.delete(ticketId);
}

/**
 * Is this ticket's worktree protected right now?
 *
 * Lazily evicts an expired entry so a crashed runner's slot frees on the next query rather than
 * needing a sweep of its own.
 */
export function isCollecting(ticketId: string): boolean {
  const entry = collecting.get(ticketId);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    collecting.delete(ticketId);
    return false;
  }
  return true;
}

/** Every ticket currently protected. Diagnostics only. */
export function listCollecting(): string[] {
  return [...collecting.keys()].filter((id) => isCollecting(id));
}

/** Test seam — the module-scoped registry would otherwise leak between test files. */
export function resetCollectionGuard(): void {
  collecting.clear();
}
