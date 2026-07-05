import type { OperationEvent } from '../types';

/**
 * Combines the one-time backfill fetch with the live SSE-fed buffer for the Operations tab
 * (S11, FLUX-1007). Dedupes by `opId` — the live buffer only starts from when the SSE
 * connection first opened, so it can overlap with the backfill on the tail end — then sorts by
 * `endedAt` so the merged view reads oldest-to-newest regardless of which source an op came from.
 */
export function mergeOperations(
  backfill: readonly OperationEvent[],
  live: readonly OperationEvent[],
): OperationEvent[] {
  const seen = new Set<string>();
  const combined: OperationEvent[] = [];
  for (const op of [...backfill].reverse()) {
    if (seen.has(op.opId)) continue;
    seen.add(op.opId);
    combined.push(op);
  }
  for (const op of live) {
    if (seen.has(op.opId)) continue;
    seen.add(op.opId);
    combined.push(op);
  }
  combined.sort((a, b) => a.endedAt - b.endedAt);
  return combined;
}
