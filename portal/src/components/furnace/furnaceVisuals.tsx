// Shared Furnace-batch visual helpers (FLUX-1539): the icon map + per-batch color hash used by
// both the batch drawer (FurnaceDrawer.tsx) and board cards (TaskCard.tsx) — kept in one module so
// neither has to import the other.

import { Bolt, FlaskConical, Layers, Flame, Zap, Filter } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FurnaceBatch } from '../../furnaceTypes';

export const ICON_BY_KEY: Record<string, LucideIcon> = {
  bolt: Bolt, beaker: FlaskConical, layers: Layers, flame: Flame, zap: Zap, filter: Filter,
};

export function iconFor(batch: FurnaceBatch | { icon?: string }): LucideIcon {
  return (batch.icon && ICON_BY_KEY[batch.icon]) || Layers;
}

/** Deterministic FNV hash of an id -> a 0-359 hue. Stable across renders, unique per id. */
export function hueFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0) % 360;
}

/** Card border color for a batch, derived from its id — two different batches get visibly
 *  distinct colors; two cards in the same batch always match. */
export function batchBorderColor(batchId: string): string {
  return `hsl(${hueFromId(batchId)} 70% 58%)`;
}
