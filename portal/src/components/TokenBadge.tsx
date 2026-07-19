import { memo } from 'react';
import type { Config } from '../types';

interface TokenData {
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  costIsEstimated?: boolean;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface TokenBadgeProps {
  data: TokenData | null | undefined;
  config: Config | null;
  onToggle?: () => void;
  /** Variant controls visual style. 'card' is compact pill, 'panel' is inline text, 'modal' is the larger stacked badge */
  variant?: 'card' | 'panel' | 'modal';
  label?: string;
}

function getThresholdColor(costUSD: number, thresholds?: { green: number; yellow: number }): string {
  const green = thresholds?.green ?? 0.10;
  const yellow = thresholds?.yellow ?? 0.50;
  if (costUSD < green) return 'text-emerald-600 dark:text-emerald-400';
  if (costUSD < yellow) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * Everything the badge actually paints, derived from `data`/`config`. Shared by the render body
 * and the `React.memo` comparator (FLUX-1553) so "does the visible pill change" is answered by
 * ONE computation — the strings/classes here are already quantized to display precision
 * (`.toFixed`, threshold buckets), so comparing them is exactly "did the rendered output change",
 * not a guessed staleness threshold.
 */
function computeTokenBadgeDisplay(data: TokenData | null | undefined, config: Config | null) {
  const showTokens = config?.tokenDisplayMode === 'tokens';
  const thresholds = config?.tokenCostThresholds;

  const inTok = data?.inputTokens ?? 0;
  const outTok = data?.outputTokens ?? 0;
  const costUSD = data?.costUSD ?? 0;
  const isEstimated = data?.costIsEstimated ?? false;
  const cacheRead = data?.cacheReadTokens ?? 0;
  const cacheCreation = data?.cacheCreationTokens ?? 0;
  const freshInput = inTok - cacheRead - cacheCreation;

  const hasData = inTok > 0 || outTok > 0;

  const displayLabel = showTokens
    ? (hasData ? `↑${(inTok / 1000).toFixed(1)}k ↓${(outTok / 1000).toFixed(1)}k` : '—')
    : costUSD > 0
      ? `$${costUSD.toFixed(2)}${isEstimated ? '~' : ''}`
      : hasData
        ? `↑${(inTok / 1000).toFixed(1)}k ↓${(outTok / 1000).toFixed(1)}k`
        : '$0.00';

  const tooltipParts = [
    `↑ ${inTok.toLocaleString()} input / ↓ ${outTok.toLocaleString()} output tokens`,
    cacheRead > 0 ? `Cache read: ${cacheRead.toLocaleString()}` : null,
    cacheCreation > 0 ? `Cache creation: ${cacheCreation.toLocaleString()}` : null,
    freshInput > 0 && (cacheRead > 0 || cacheCreation > 0) ? `Fresh input: ${freshInput.toLocaleString()}` : null,
    isEstimated ? '(estimated)' : null,
  ].filter(Boolean).join(' · ');

  const tooltip = data ? tooltipParts : 'No token data recorded yet';

  const colorClass = !showTokens && costUSD > 0 ? getThresholdColor(costUSD, thresholds) : '';

  // FLUX-1375: fresh/cache-read/cache-creation split, surfaced inline on the modal variant only.
  const hasCacheSplit = cacheRead > 0 || cacheCreation > 0;
  const breakdownLabel = hasCacheSplit
    ? [
        freshInput > 0 ? `${(freshInput / 1000).toFixed(1)}k fresh` : null,
        cacheRead > 0 ? `${(cacheRead / 1000).toFixed(1)}k cached` : null,
        cacheCreation > 0 ? `${(cacheCreation / 1000).toFixed(1)}k new-cache` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return { showTokens, isEstimated, displayLabel, tooltip, colorClass, breakdownLabel };
}

function TokenBadgeImpl({ data, config, onToggle, variant = 'card', label }: TokenBadgeProps) {
  const { showTokens, isEstimated, displayLabel, tooltip, colorClass, breakdownLabel } = computeTokenBadgeDisplay(data, config);

  if (variant === 'modal') {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={tooltip}
        className="flex flex-col items-start rounded-lg border border-gray-200 bg-white/60 px-3 py-1 text-left dark:border-white/10 dark:bg-white/5 hover:border-primary/40 hover:bg-primary/5 dark:hover:border-primary/30 dark:hover:bg-primary/10 transition-colors cursor-pointer"
      >
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          {label ?? (showTokens ? 'Tokens' : `Ticket Cost${isEstimated ? ' ~' : ''}`)}
        </span>
        <span className={`text-sm font-semibold ${colorClass || 'text-gray-700 dark:text-gray-200'}`}>
          {displayLabel}
        </span>
        {breakdownLabel && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{breakdownLabel}</span>
        )}
      </button>
    );
  }

  if (variant === 'panel') {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={tooltip}
        className={`hover:underline cursor-pointer ${colorClass}`}
      >
        {label ? `${label}: ` : ''}{displayLabel}
      </button>
    );
  }

  // card variant — compact pill
  return (
    <button
      type="button"
      onClick={onToggle}
      title={tooltip}
      className={`rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium dark:bg-black/20 transition-colors hover:bg-gray-200 dark:hover:bg-black/30 cursor-pointer ${colorClass || 'text-gray-500 dark:text-gray-400'}`}
    >
      {displayLabel}
    </button>
  );
}

/**
 * FLUX-1553: memoized against the *displayed* value, not raw props — `data` mints a new object
 * reference on every SSE token tick (`patchTaskLocal`, unthrottled), which would otherwise
 * re-render every card's pill on every stream chunk even when the rounded label/color it paints
 * hasn't moved. `computeTokenBadgeDisplay` is the single source for both the render and this
 * comparator, so "unchanged" here always means "the actual rendered output is identical" — it can
 * never skip a genuinely visible change.
 */
export const TokenBadge = memo(TokenBadgeImpl, (prev, next) => {
  if (prev.onToggle !== next.onToggle) return false;
  if (prev.variant !== next.variant) return false;
  if (prev.label !== next.label) return false;
  const a = computeTokenBadgeDisplay(prev.data, prev.config);
  const b = computeTokenBadgeDisplay(next.data, next.config);
  return (
    a.showTokens === b.showTokens &&
    a.isEstimated === b.isEstimated &&
    a.displayLabel === b.displayLabel &&
    a.colorClass === b.colorClass &&
    a.breakdownLabel === b.breakdownLabel
  );
});
