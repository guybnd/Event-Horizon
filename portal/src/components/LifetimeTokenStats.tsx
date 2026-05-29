import { useState, useEffect } from 'react';
import { Bot } from 'lucide-react';
import { useApp } from '../AppContext';

export function LifetimeTokenStats() {
  const { tasks, config, saveConfig } = useApp();
  const [lifetimeCostUSD, setLifetimeCostUSD] = useState<number | null>(null);
  const [lifetimeTokens, setLifetimeTokens] = useState<{ input: number; output: number; estimated: boolean } | null>(null);
  const [costStatsLoaded, setCostStatsLoaded] = useState(false);

  useEffect(() => {
    async function loadTokenStats() {
      try {
        const res = await fetch('/api/stats/tokens');
        if (!res.ok) return;
        const data = await res.json();
        setLifetimeCostUSD(data.lifetime?.costUSD ?? 0);
        setCostStatsLoaded(true);
        const lTok = data.lifetime;
        if (lTok && ((lTok.inputTokens ?? 0) > 0 || (lTok.outputTokens ?? 0) > 0)) {
          setLifetimeTokens({ input: lTok.inputTokens ?? 0, output: lTok.outputTokens ?? 0, estimated: lTok.costIsEstimated ?? false });
        } else {
          setLifetimeTokens(null);
        }
      } catch {
        // non-critical
      }
    }
    loadTokenStats();
  }, [tasks]);

  if (!costStatsLoaded) return null;

  return (
    <button
      type="button"
      onClick={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
      className="group flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 bg-white/60 px-2.5 py-1.5 text-gray-500 transition-all duration-200 overflow-hidden dark:border-white/10 dark:bg-white/5 dark:text-gray-400 hover:border-primary/40 hover:bg-primary/5 dark:hover:border-primary/30 dark:hover:bg-primary/10 cursor-pointer tabular-nums"
      title={config?.tokenDisplayMode === 'tokens'
        ? `Lifetime tokens · ↑ ${(lifetimeTokens?.input ?? 0).toLocaleString()} / ↓ ${(lifetimeTokens?.output ?? 0).toLocaleString()} · Click to switch to cost`
        : `Lifetime Claude API cost across all tickets${lifetimeTokens ? ` · ↑ ${lifetimeTokens.input.toLocaleString()} / ↓ ${lifetimeTokens.output.toLocaleString()} tokens` : ''}${lifetimeTokens?.estimated ? ' (estimated)' : ''} · Click to switch to tokens`}
    >
      <Bot className="h-3.5 w-3.5 shrink-0" />
      {config?.tokenDisplayMode === 'tokens' ? (
        <span className="text-sm font-semibold leading-none">
          ↑{((lifetimeTokens?.input ?? 0) / 1000).toFixed(1)}k ↓{((lifetimeTokens?.output ?? 0) / 1000).toFixed(1)}k
        </span>
      ) : (lifetimeCostUSD ?? 0) > 0 ? (
        <span className="text-sm font-semibold leading-none">
          ${lifetimeCostUSD!.toFixed(2)}{lifetimeTokens?.estimated ? '~' : ''}
        </span>
      ) : lifetimeTokens ? (
        <span className="text-sm font-semibold leading-none">
          ↑{(lifetimeTokens.input / 1000).toFixed(1)}k ↓{(lifetimeTokens.output / 1000).toFixed(1)}k
        </span>
      ) : (
        <span className="text-sm font-semibold leading-none">$0.00</span>
      )}
      <span className="max-w-0 overflow-hidden opacity-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider transition-all duration-200 group-hover:max-w-[60px] group-hover:opacity-100 group-hover:ml-0.5">
        {config?.tokenDisplayMode === 'tokens' ? 'Tokens' : 'Cost'}
      </span>
    </button>
  );
}
