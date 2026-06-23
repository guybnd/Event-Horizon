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

export function TokenBadge({ data, config, onToggle, variant = 'card', label }: TokenBadgeProps) {
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
