import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ProviderUsage, UsageGauge } from '../types';
import { barPercent, fullness, windowLabel } from '../lib/capacityUsage';
import { gaugeFigure, providerLabel, resetCountdown } from '../lib/capacityFormat';
import { ProvenanceBar } from './ProvenanceBar';

interface Props {
  providers: ProviderUsage[];
  onClose: () => void;
}

function gaugeLabel(gauge: UsageGauge): string {
  const win = windowLabel(gauge.windowMinutes);
  return win ? `${gauge.label} (${win})` : gauge.label;
}

/** One provider's gauges, sorted by `fullness` with unrankable rows last (never dropped). */
function GaugeRow({ gauge, now }: { gauge: UsageGauge; now: number }) {
  const countdown = resetCountdown(gauge.resetsAt, now);
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-300">{gaugeLabel(gauge)}</span>
        <span className="shrink-0 font-mono text-gray-500 dark:text-gray-400">{gaugeFigure(gauge)}</span>
      </div>
      {!gauge.unlimited && (
        <ProvenanceBar provenance={gauge.provenance} percent={barPercent(gauge)} percentFloor={gauge.percentFloor} label={gaugeLabel(gauge)} />
      )}
      {countdown && <span className="text-[10px] text-gray-400">{countdown}</span>}
    </div>
  );
}

function ProviderSection({ provider, now }: { provider: ProviderUsage; now: number }) {
  const rows = [...provider.gauges].sort((a, b) => {
    const fa = fullness(a);
    const fb = fullness(b);
    if (fa == null && fb == null) return 0;
    if (fa == null) return 1;
    if (fb == null) return -1;
    return fb - fa;
  });

  return (
    <div className="border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-white/5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{providerLabel(provider.provider)}</div>
      {provider.provenance === 'unknown' || rows.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
          {provider.reason || 'Capacity not exposed for this provider'}
        </p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-white/5">
          {rows.map((g) => (
            <GaugeRow key={g.id} gauge={g} now={now} />
          ))}
        </div>
      )}
      {provider.lastWall && (
        <p className="mt-1 text-[10px] text-amber-500 dark:text-amber-400">
          Last wall: {provider.lastWall.rateLimitType || 'rate limited'}
          {provider.lastWall.observedAt && ` — ${new Date(provider.lastWall.observedAt).toLocaleString()}`}
          {resetCountdown(provider.lastWall.resetsAt, now) ? `, ${resetCountdown(provider.lastWall.resetsAt, now)}` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * Header capacity popover (FLUX-1748): every provider's gauges, grouped BY PROVIDER — windows
 * aren't comparable across providers (Codex rolls 5-hourly on tokens, Copilot monthly on
 * requests), so this never renders a cross-provider merged list.
 */
export function CapacityPopover({ providers, onClose }: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="absolute right-0 top-full z-[100] mt-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95"
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-white/5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Capacity</h3>
        <button onClick={onClose} className="rounded-md p-1 transition-colors hover:bg-gray-100 dark:hover:bg-white/10">
          <X className="h-4 w-4 text-gray-400" />
        </button>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {providers.map((p) => (
          <ProviderSection key={p.provider} provider={p} now={now} />
        ))}
      </div>
    </div>
  );
}
