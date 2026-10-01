import { useAppSelector } from '../../store/useAppSelector';
import type { ProviderUsage, UsageGauge } from '../../types';
import { barPercent, windowLabel } from '../../lib/capacityUsage';
import { gaugeFigure, providerLabel, resetCountdown } from '../../lib/capacityFormat';
import { ProvenanceBar } from '../ProvenanceBar';

/** Sparkline needs at least this many samples to draw a line — FLUX-1747's history ring is
 *  in-memory and cleared by every engine restart, so a fresh boot routinely has 0-2 samples.
 *  Drawing a line through fewer would render a flat baseline that reads as "measured zero", the
 *  same zero-vs-unknown confusion the bars are built to avoid. */
const MIN_SPARKLINE_SAMPLES = 3;

function Sparkline({ gauge, history }: { gauge: UsageGauge; history: ProviderUsage['history'] }) {
  const points = history.filter((h) => h.gaugeId === gauge.id);
  if (points.length < MIN_SPARKLINE_SAMPLES) {
    return (
      <span className="text-[10px] italic text-gray-400 dark:text-gray-500">
        history since engine start ({points.length} sample{points.length === 1 ? '' : 's'})
      </span>
    );
  }
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const width = 120;
  const height = 24;
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((p.value - min) / range) * height).toFixed(1)}`)
    .join(' ');
  const dashed = gauge.provenance !== 'exact';
  // "24h" is accurate only because `usage-store.ts`'s HISTORY_WINDOW_MS already trims `history` to
  // that window server-side — this component does no time-windowing of its own.
  return (
    <svg width={width} height={height} className="shrink-0" aria-label={`${points.length}-sample 24h history`}>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={dashed ? '3 2' : undefined}
        className="text-primary/70"
      />
    </svg>
  );
}

function ProviderCard({ provider }: { provider: ProviderUsage }) {
  if (provider.provenance === 'unknown' || provider.gauges.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-4 py-3 dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">{providerLabel(provider.provider)}</span>
          <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-400">
            unknown
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
          {provider.reason || 'No local usage file found'}
        </p>
      </div>
    );
  }

  // Settings is a static snapshot with no tick loop (unlike the popover's 1s-ticking countdown),
  // so this is computed once per render rather than live-updating — fine for a settings tab.
  const lastWallCountdown = provider.lastWall ? resetCountdown(provider.lastWall.resetsAt, Date.now()) : undefined;

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-black/10">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{providerLabel(provider.provider)}</span>
        {provider.planType && (
          <span className="text-[10px] text-gray-400">{provider.planType}</span>
        )}
      </div>
      <div className="space-y-3">
        {provider.gauges.map((gauge) => {
          const win = windowLabel(gauge.windowMinutes);
          return (
            <div key={gauge.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-300">
                  {gauge.label}{win ? ` (${win})` : ''}
                </span>
                <span className="shrink-0 font-mono text-gray-500 dark:text-gray-400">{gaugeFigure(gauge)}</span>
              </div>
              <div className="flex items-center gap-3">
                {!gauge.unlimited && (
                  <ProvenanceBar provenance={gauge.provenance} percent={barPercent(gauge)} percentFloor={gauge.percentFloor} className="max-w-[160px]" />
                )}
                <Sparkline gauge={gauge} history={provider.history} />
              </div>
              <div className="flex flex-wrap gap-x-3 text-[10px] text-gray-400 dark:text-gray-500">
                {gauge.source && (
                  <span title={gauge.source.path}>
                    source: {gauge.source.path.split(/[\\/]/).pop()} · {Math.round(gauge.source.ageMs / 1000)}s ago
                  </span>
                )}
                {gauge.freshness !== 'live' && <span className="text-amber-500 dark:text-amber-400">{gauge.freshness}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {provider.lastWall && (
        <p className="mt-2 text-[10px] text-amber-500 dark:text-amber-400">
          Last wall: {provider.lastWall.rateLimitType || 'rate limited'}
          {provider.lastWall.observedAt && ` — ${new Date(provider.lastWall.observedAt).toLocaleString()}`}
          {lastWallCountdown ? `, ${lastWallCountdown}` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * Read-only Capacity settings tab (FLUX-1748) — the same gauges as the header chip/popover, plus
 * their receipts (source file, parse age) and a 24h sparkline per gauge. Unknown providers always
 * render as one dimmed card carrying `reason` — never dropped from the list.
 */
export function CapacitySection() {
  const usage = useAppSelector((s) => s.usage);
  const providers = usage?.providers ?? [];

  if (!usage) {
    return <p className="text-xs text-gray-400">Loading capacity…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Capacity</h3>
        <p className="text-xs text-gray-500">
          Local capacity readings per CLI provider. Read-only — there is nothing here to save.
          Last updated {new Date(usage.generatedAt).toLocaleTimeString()}.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {providers.map((p) => (
          <ProviderCard key={p.provider} provider={p} />
        ))}
      </div>
    </div>
  );
}
