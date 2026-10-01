import type { Provenance } from '../types';

export interface ProvenanceBarProps {
  provenance: Provenance;
  /** Percent consumed (0-100), for `exact` gauges and `floor` gauges that DO have a denominator. */
  percent?: number;
  /** Percent consumed floor (0-100) for a `floor` gauge WITH a denominator — renders a hatched fill
   *  up to this value plus a lighter "could be more" indeterminate zone extending to the track end.
   *  A `floor` gauge with no `percentFloor` (Claude Code today — see `computeClaudeFloorUsage`) has
   *  NOTHING computable to fill and renders identically to `unknown`: a dashed, empty track. Never
   *  fabricate a number here. */
  percentFloor?: number;
  label?: string;
  className?: string;
}

/**
 * The one gauge-fill primitive shared by the capacity chip, popover, settings tab and (via its
 * provenance-only track styling) the session context strip. Three visually distinct states so a
 * real `0%` reading is never confusable with "we don't know":
 *  - `exact` → solid fill at `percent`.
 *  - `floor` + `percentFloor` → hatched fill to `percentFloor`, then a lighter hatched
 *    "indeterminate zone" from there to the track end (the true figure can only be higher).
 *  - `floor` without `percentFloor`, or `unknown` → dashed empty track, no fill, no `aria-valuenow`.
 */
export function ProvenanceBar({ provenance, percent, percentFloor, label, className = '' }: ProvenanceBarProps) {
  const isFloorWithFloorPercent = provenance === 'floor' && percentFloor != null;
  const isUnknownStyle = provenance === 'unknown' || (provenance === 'floor' && percentFloor == null);

  const ariaProps: Record<string, string | number> = { role: 'progressbar' };
  if (provenance === 'exact' && percent != null) {
    ariaProps['aria-valuenow'] = percent;
  } else if (isFloorWithFloorPercent) {
    ariaProps['aria-valuenow'] = percentFloor as number;
    ariaProps['aria-valuetext'] = `at least ${Math.round(percentFloor as number)}%`;
  }
  if (label) ariaProps['aria-label'] = label;

  return (
    <div
      className={`eh-provenance-bar relative h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-white/10 ${
        isUnknownStyle ? 'eh-provenance-bar--unknown border border-dashed border-gray-300 bg-transparent dark:border-white/20' : ''
      } ${className}`}
      data-provenance={provenance}
      {...ariaProps}
    >
      {provenance === 'exact' && (
        <div
          className="eh-provenance-bar__fill h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
        />
      )}
      {isFloorWithFloorPercent && (
        <>
          <div
            className="eh-provenance-bar__fill--floor absolute inset-y-0 left-0 rounded-l-full"
            style={{ width: `${Math.max(0, Math.min(100, percentFloor as number))}%` }}
          />
          <div
            className="eh-provenance-bar__fill--floor-indeterminate absolute inset-y-0 rounded-r-full"
            style={{ left: `${Math.max(0, Math.min(100, percentFloor as number))}%`, right: 0 }}
          />
        </>
      )}
    </div>
  );
}
