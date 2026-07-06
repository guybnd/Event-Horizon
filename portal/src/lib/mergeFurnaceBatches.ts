import type { FurnaceBatch } from '../furnaceTypes';

/**
 * Reuses object identity for unchanged batches when merging a fresh `/api/furnace` poll result —
 * the Furnace-drawer analogue of `tasksEqual`'s board-side fix (FLUX-724). Every batch mutation
 * goes through `mutateFurnaceBatch` on the engine (furnace-store.ts), which unconditionally bumps
 * `updatedAt`, so `id` + `updatedAt` alone is a reliable per-batch version stamp — no field-by-field
 * diff needed. When nothing changed at all (an idle poll), returns `prev` itself so the caller's
 * `setState` bails out and the drawer produces zero re-renders (FLUX-1196).
 */
export function mergeFurnaceBatches(prev: FurnaceBatch[], next: readonly FurnaceBatch[]): FurnaceBatch[] {
  const prevById = new Map(prev.map((b) => [b.id, b]));
  let changed = prev.length !== next.length;
  const merged = next.map((b) => {
    const old = prevById.get(b.id);
    if (old && old.updatedAt === b.updatedAt) return old;
    changed = true;
    return b;
  });
  if (!changed) {
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== merged[i]) { changed = true; break; }
    }
  }
  return changed ? merged : prev;
}
