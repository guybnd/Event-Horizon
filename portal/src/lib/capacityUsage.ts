import type { ProviderUsage, UsageGauge } from '../types';

/**
 * FLUX-1748: the ONE comparison key every capacity-ordering surface (chip, popover, sparkline
 * sort) uses to rank gauges across heterogeneous units — token percents, percent-less request
 * counts, floors with no denominator. Returns `undefined` ("unrankable") rather than `0` for a
 * gauge with nothing computable, so a percent-less `195/200 requests` gauge (which resolves via
 * the third branch) is never silently outranked by a token gauge that merely HAS a `percent`.
 *
 * `percent`/`percentFloor` are always "percent consumed", never remaining — a provider that
 * natively publishes a remaining-percentage (e.g. Copilot's raw `remainingPercentage`) must be
 * inverted by its probe before this ever sees it; inverting here would rank the emptiest gauge as
 * the most binding constraint.
 *
 * An `unlimited` gauge (FLUX-1748 M1) is always unrankable, regardless of `used`/`limit` — those
 * fields describe a non-binding count on an unlimited entitlement, not a fraction of a wall, so
 * `used > limit` (e.g. Copilot reporting 900/300 on an unlimited plan) must never be read as "over
 * 100% consumed" and hijack the chip's worst-gauge pick.
 */
export function fullness(gauge: UsageGauge): number | undefined {
  if (gauge.unlimited) return undefined;
  if (gauge.percent != null) return gauge.percent;
  if (gauge.percentFloor != null) return gauge.percentFloor;
  if (gauge.used != null && gauge.limit) return (gauge.used / gauge.limit) * 100;
  return undefined;
}

/**
 * The bar-fill percent for a gauge (FLUX-1748 B1) — distinct from `fullness` because a `floor`
 * gauge's `percentFloor` belongs only in the floor-specific fill channel (`ProvenanceBar`'s
 * `percentFloor` prop), never here. Derives a percent from `used`/`limit` when the gauge has no
 * `percent` of its own — every Copilot gauge (`unit:'requests'`), since its probe deliberately
 * never maps the raw `remainingPercentage` field. Returns `undefined` for an `unlimited` gauge:
 * there is no fraction of a wall to draw.
 */
export function barPercent(gauge: UsageGauge): number | undefined {
  if (gauge.unlimited) return undefined;
  if (gauge.percent != null) return gauge.percent;
  if (gauge.used != null && gauge.limit) return (gauge.used / gauge.limit) * 100;
  return undefined;
}

/** A gauge is "rankable" iff `fullness` resolves to a real number. */
export function isRankable(gauge: UsageGauge): boolean {
  return fullness(gauge) != null;
}

/** Derives a short window label from `windowMinutes` — never hardcode "5-hour"/"weekly" text,
 *  since a provider may report any window. 300 -> "5 h", 10080 -> "7 d", 90 -> "90 m". */
export function windowLabel(windowMinutes: number | undefined): string | undefined {
  if (windowMinutes == null) return undefined;
  if (windowMinutes % (24 * 60) === 0) return `${windowMinutes / (24 * 60)} d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60} h`;
  return `${windowMinutes} m`;
}

export interface RankedGauge {
  provider: ProviderUsage['provider'];
  gauge: UsageGauge;
  fullness: number;
}

/**
 * The header chip's single "worst gauge" pick across every provider's gauges — max `fullness`,
 * excluding `unknown` and unrankable gauges. Returns `undefined` when nothing is rankable (every
 * gauge is `unknown`, or every non-`unknown` gauge lacks a computable `fullness`).
 */
export function worstRankableGauge(providers: ProviderUsage[]): RankedGauge | undefined {
  let best: RankedGauge | undefined;
  for (const p of providers) {
    for (const g of p.gauges) {
      if (g.provenance === 'unknown') continue;
      const f = fullness(g);
      if (f == null) continue;
      if (!best || f > best.fullness) best = { provider: p.provider, gauge: g, fullness: f };
    }
  }
  return best;
}

/** The first provider carrying a non-`unknown` gauge that is NOT rankable (e.g. Claude's floor
 *  with consumed tokens but no denominator) — the chip's fallback case when nothing is rankable
 *  but capacity data still exists (never invents a number to make it comparable). */
export function firstUnrankableProvider(providers: ProviderUsage[]): ProviderUsage | undefined {
  return providers.find((p) => p.gauges.some((g) => g.provenance !== 'unknown' && !isRankable(g)));
}
