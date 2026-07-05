import type { EngineEvent } from '../store/appStore';

/**
 * Applies a batch of buffered SSE events onto the Engine-events ring buffer in one shot
 * (FLUX-1138). Pulled out of AppContext's per-animation-frame flush so the append+cap math is
 * unit-testable without mounting the SSE effect.
 */
export function appendEngineEvents(
  prev: readonly EngineEvent[],
  pending: readonly EngineEvent[],
  max: number,
): EngineEvent[] {
  if (pending.length === 0) return prev as EngineEvent[];
  const next = [...prev, ...pending];
  return next.length > max ? next.slice(-max) : next;
}
