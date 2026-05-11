import type { BoardCardOpenMode } from '../../types';
import { SettingToggleCard } from './shared';

interface PreferencesSectionProps {
  boardCardOpenMode: BoardCardOpenMode;
  setBoardCardOpenMode: (v: BoardCardOpenMode) => void;
  animationsEnabled: boolean;
  setAnimationsEnabled: (v: boolean) => void;
  animationSpeed: 'fast' | 'normal' | 'slow';
  setAnimationSpeed: (v: 'fast' | 'normal' | 'slow') => void;
  enableFireworks: boolean;
  setEnableFireworks: (v: boolean) => void;
  hoverPopupsEnabled: boolean;
  setHoverPopupsEnabled: (v: boolean) => void;
  hoverPopupDelay: number;
  setHoverPopupDelay: (v: number) => void;
  tokenDisplayMode: 'cost' | 'tokens';
  setTokenDisplayMode: (v: 'cost' | 'tokens') => void;
  tokenCostThresholds: { green: number; yellow: number };
  setTokenCostThresholds: (v: { green: number; yellow: number }) => void;
  enableBacklog: boolean;
  setEnableBacklog: (v: boolean) => void;
  requireComment: boolean;
  setRequireComment: (v: boolean) => void;
  generateDistinctFiles: boolean;
  setGenerateDistinctFiles: (v: boolean) => void;
  releaseNotesPath: string;
  setReleaseNotesPath: (v: string) => void;
}

export function PreferencesSection({
  boardCardOpenMode,
  setBoardCardOpenMode,
  animationsEnabled,
  setAnimationsEnabled,
  animationSpeed,
  setAnimationSpeed,
  enableFireworks,
  setEnableFireworks,
  hoverPopupsEnabled,
  setHoverPopupsEnabled,
  hoverPopupDelay,
  setHoverPopupDelay,
  tokenDisplayMode,
  setTokenDisplayMode,
  tokenCostThresholds,
  setTokenCostThresholds,
  enableBacklog,
  setEnableBacklog,
  requireComment,
  setRequireComment,
  generateDistinctFiles,
  setGenerateDistinctFiles,
  releaseNotesPath,
  setReleaseNotesPath,
}: PreferencesSectionProps) {
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Release Settings</h3>
          <p className="text-xs text-gray-500 mb-4 text-balance">Configure how release notes are generated when releasing Done tickets.</p>
          <div className="space-y-4 max-w-lg">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-bold text-gray-700 dark:text-gray-300">Release Notes Output</label>
              <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20 w-fit">
                <button
                  type="button"
                  onClick={() => setGenerateDistinctFiles(true)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${generateDistinctFiles ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                >
                  Distinct file per version
                </button>
                <button
                  type="button"
                  onClick={() => setGenerateDistinctFiles(false)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${!generateDistinctFiles ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                >
                  Append to single file
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-bold text-gray-700 dark:text-gray-300">Release Notes Sub-Folder / File Path</label>
              <input
                value={releaseNotesPath}
                onChange={e => setReleaseNotesPath(e.target.value)}
                className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm"
                placeholder="e.g. release-notes"
              />
              <p className="text-[11px] text-gray-500">
                {generateDistinctFiles
                  ? `Will generate distinct files under .docs/${releaseNotesPath}/{version}.md`
                  : `Will append to the single file .docs/${releaseNotesPath}/release_notes.md`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Board Card Click Behavior</span>
              <span className="text-xs text-gray-500">Choose whether clicking a board card opens the full ticket view or the popup editor. The shipped default is full view.</span>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20">
              <button
                type="button"
                onClick={() => setBoardCardOpenMode('full')}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${boardCardOpenMode === 'full' ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
              >
                Full View
              </button>
              <button
                type="button"
                onClick={() => setBoardCardOpenMode('popup')}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${boardCardOpenMode === 'popup' ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
              >
                Popup View
              </button>
            </div>
          </div>
        </div>

        <SettingToggleCard
          title="Ticket Animations"
          description="Enable fluid layout animations when opening and closing tickets."
          checked={animationsEnabled}
          onChange={setAnimationsEnabled}
        >
          {animationsEnabled && (
            <select
              value={animationSpeed}
              onChange={(e) => setAnimationSpeed(e.target.value as 'fast' | 'normal' | 'slow')}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            >
              <option value="fast">Fast</option>
              <option value="normal">Normal</option>
              <option value="slow">Slow</option>
            </select>
          )}
        </SettingToggleCard>

        <SettingToggleCard
          title="Celebrate Done Tickets"
          description="Show fireworks when moving a ticket into the Done column."
          checked={enableFireworks}
          onChange={setEnableFireworks}
        />

        <SettingToggleCard
          title="Card Hover Preview"
          description="Show full description popup on hover. Optionally configure the delay in ms."
          checked={hoverPopupsEnabled}
          onChange={setHoverPopupsEnabled}
        >
          {hoverPopupsEnabled && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Delay (ms)</span>
              <input
                type="number"
                value={hoverPopupDelay}
                onChange={(e) => setHoverPopupDelay(Number(e.target.value) || 1500)}
                className="w-20 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                min="0"
                step="100"
              />
            </div>
          )}
        </SettingToggleCard>

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

        <SettingToggleCard
          title="Enable Backlog Screen"
          description="If disabled, the backlog will simply appear as a normal column on the board (if not listed in Hidden Statuses)."
          checked={enableBacklog}
          onChange={setEnableBacklog}
        />

        <SettingToggleCard
          title="Require Comment on Status Change"
          description="Prompt for a comment pop-up when dragging a task to a new column on the board."
          checked={requireComment}
          onChange={setRequireComment}
        />
      </div>
    </div>
  );
}
