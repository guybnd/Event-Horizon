import { SettingToggleCard } from './shared';

interface CostTokensSectionProps {
  tokenDisplayMode: 'cost' | 'tokens';
  setTokenDisplayMode: (v: 'cost' | 'tokens') => void;
  tokenCostThresholds: { green: number; yellow: number };
  setTokenCostThresholds: (v: { green: number; yellow: number }) => void;
}

export function CostTokensSection({
  tokenDisplayMode,
  setTokenDisplayMode,
  tokenCostThresholds,
  setTokenCostThresholds,
}: CostTokensSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Cost &amp; Tokens</h3>
        <p className="text-xs text-gray-500 mb-2 text-balance">How agent session spend is surfaced on cards, the modal, and the top bar.</p>
      </div>

      <SettingToggleCard
        title="Show Token Count Instead of Cost"
        description="Display raw input/output token counts instead of estimated USD cost on cards, the modal, and the top bar."
        checked={tokenDisplayMode === 'tokens'}
        onChange={(v) => setTokenDisplayMode(v ? 'tokens' : 'cost')}
      />

      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Cost Badge Color Thresholds</span>
        <span className="block text-xs text-gray-500 mb-4">Color-code cost badges green / amber / red based on USD cost per ticket.</span>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shrink-0" />
            <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">Green below $</span>
            <input
              type="number"
              value={tokenCostThresholds.green}
              onChange={e => setTokenCostThresholds({ ...tokenCostThresholds, green: parseFloat(e.target.value) || 0 })}
              className="w-20 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
              min="0"
              step="0.01"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shrink-0" />
            <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">Amber below $</span>
            <input
              type="number"
              value={tokenCostThresholds.yellow}
              onChange={e => setTokenCostThresholds({ ...tokenCostThresholds, yellow: parseFloat(e.target.value) || 0 })}
              className="w-20 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
              min="0"
              step="0.01"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 shrink-0" />
            <span className="text-xs text-gray-500 dark:text-gray-400">Red above amber threshold</span>
          </div>
        </div>
      </div>
    </div>
  );
}
