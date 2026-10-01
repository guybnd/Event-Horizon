import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { useAppSelector } from '../store/useAppSelector';
import { worstRankableGauge, firstUnrankableProvider } from '../lib/capacityUsage';
import { gaugeFigure, providerLabel, resetCountdown } from '../lib/capacityFormat';
import { CapacityPopover } from './CapacityPopover';

/**
 * Header capacity chip (FLUX-1748): the single worst gauge across every provider, by `fullness`
 * (see `lib/capacityUsage.ts`) — never an average, never a fabricated number for an unrankable
 * gauge. Opens `CapacityPopover` for the full per-provider breakdown.
 */
export function CapacityChip() {
  const usage = useAppSelector((s) => s.usage);
  const [isOpen, setIsOpen] = useState(false);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const close = useCallback(() => setIsOpen(false), []);

  const providers = useMemo(() => usage?.providers ?? [], [usage]);
  const hasCountdown = useMemo(
    () => providers.some((p) => p.gauges.some((g) => g.resetsAt != null)),
    [providers],
  );

  // Coarse tick for the reset countdown text — the chip is always mounted (unlike the popover,
  // which only ticks at 1s while open), so this stays deliberately infrequent. Gated on there
  // being a countdown to tick at all — no gauge has `resetsAt` on a Claude-only or all-unknown
  // board, and re-rendering the header every 30s for nothing is wasted work.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasCountdown) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [hasCountdown]);

  const content = useMemo(() => {
    const worst = worstRankableGauge(providers);
    if (worst) {
      const countdown = resetCountdown(worst.gauge.resetsAt, now);
      return {
        text: `${providerLabel(worst.provider)} ${gaugeFigure(worst.gauge)}`,
        title: `${providerLabel(worst.provider)} — ${gaugeFigure(worst.gauge)}, the most-consumed gauge across providers${countdown ? `, ${countdown}` : ''}`,
        dash: false,
      };
    }
    const unrankable = firstUnrankableProvider(providers);
    if (unrankable) {
      const gauge = unrankable.gauges.find((g) => g.provenance !== 'unknown');
      return {
        text: '—',
        title: gauge
          ? `${providerLabel(unrankable.provider)} — ${gaugeFigure(gauge)}, scale unknown`
          : `${providerLabel(unrankable.provider)} — scale unknown`,
        dash: true,
      };
    }
    return { text: '—', title: 'Capacity not exposed', dash: true };
  }, [providers, now]);

  return (
    <div className="relative">
      <button
        onClick={toggle}
        className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400 ${isOpen ? 'ring-2 ring-primary/30' : ''}`}
        title={content.title}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[11px] font-semibold leading-none">{content.text}</span>
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Capacity</span>
      </button>
      <AnimatePresence>
        {isOpen && <CapacityPopover providers={providers} onClose={close} />}
      </AnimatePresence>
    </div>
  );
}
