import type { Freshness, UsageGauge } from './types.js';

// FLUX-1747: per-gauge freshness rule, evaluated at read time (never cached). `stale` means one
// thing only — the observation is old. Window ambiguity (no `resetsAt`/`windowMinutes` at all) is a
// SEPARATE signal, carried by the gauge simply omitting those fields — see claude-floor.ts.
const ABSOLUTE_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

export function computeFreshness(params: { resetsAt?: string | undefined; observedAt: string; windowMinutes?: number | undefined; now?: Date | undefined }): Freshness {
  const now = (params.now ?? new Date()).getTime();
  const observedAtMs = Date.parse(params.observedAt);
  const ageMs = Number.isFinite(observedAtMs) ? now - observedAtMs : Number.POSITIVE_INFINITY;

  if (params.resetsAt) {
    const resetsAtMs = Date.parse(params.resetsAt);
    if (Number.isFinite(resetsAtMs) && resetsAtMs <= now) return 'expired';
    const halfWindowMs = params.windowMinutes != null ? (params.windowMinutes * 60_000) / 2 : Number.POSITIVE_INFINITY;
    const staleThresholdMs = Math.min(halfWindowMs, ABSOLUTE_STALE_AFTER_MS);
    return ageMs > staleThresholdMs ? 'stale' : 'live';
  }

  // No resetsAt at all: the only signal left is how old the observation itself is.
  return ageMs > ABSOLUTE_STALE_AFTER_MS ? 'stale' : 'live';
}

/**
 * Builds a finished gauge from raw probe fields: computes `freshness`, and — per the ticket's
 * expired-drops-the-value rule — strips `percent`/`used`/`percentFloor` when the gauge is
 * `expired` (a rolled-over window's last reading is void, not "still 90%").
 */
export function finalizeGauge(gauge: Omit<UsageGauge, 'freshness'>, now?: Date): UsageGauge {
  const freshness = computeFreshness({
    resetsAt: gauge.resetsAt,
    observedAt: gauge.observedAt,
    windowMinutes: gauge.windowMinutes,
    now,
  });
  const result: UsageGauge = { ...gauge, freshness };
  if (freshness === 'expired') {
    delete result.percent;
    delete result.used;
    delete result.percentFloor;
  }
  return result;
}
