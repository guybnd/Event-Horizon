import type { BoardCardOpenMode } from '../../types';
import { THEMES, type AppTheme } from '../../AppContext';
import { useAppSelector, useAppActions } from '../../store/useAppSelector';
import { useDesktopNotifications } from '../../hooks/useDesktopNotifications';
import { SettingToggleCard } from './shared';
import { WorktreesPanel } from './WorktreesPanel';

/**
 * FLUX-695: toggle for OS notifications on turn completion in an unfocused chat. Self-contained —
 * backed by `localStorage` + browser permission via `useDesktopNotifications` (a client/browser
 * concern, not server config), so it needs no prop threading. Enabling requests browser permission;
 * if the user denies/blocks it, the toggle snaps back off and the copy explains why.
 */
function DesktopNotificationsCard() {
  const { enabled, permission, supported, native, enable, disable } = useDesktopNotifications();
  const blocked = !native && supported && permission === 'denied';
  const unsupported = !native && !supported;
  const description = unsupported
    ? 'Your browser does not support desktop notifications.'
    : blocked
      ? 'Notifications are blocked for this site. Allow them in your browser settings, then re-enable here.'
      : 'Get an OS notification when an agent finishes a turn in a chat you are not currently looking at. Requires one-time browser permission. Inside the VS Code extension, the native notification surface is used automatically.';
  return (
    <SettingToggleCard
      title="Desktop Notifications on Turn Completion"
      description={description}
      checked={enabled}
      onChange={(v) => {
        if (v) void enable();
        else disable();
      }}
    />
  );
}

interface BoardFxConfig {
  columnFire?: boolean;
  ticketAgeRust?: boolean;
  dragTrail?: boolean;
  idleDust?: boolean;
  boardWeather?: boolean;
  columnFlowArrows?: boolean;
  heartbeat?: boolean;
  speedDemon?: boolean;
  doneStreak?: boolean;
  ticketDna?: boolean;
}

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
  commentHoverPreviewEnabled: boolean;
  setCommentHoverPreviewEnabled: (v: boolean) => void;
  tokenDisplayMode: 'cost' | 'tokens';
  setTokenDisplayMode: (v: 'cost' | 'tokens') => void;
  tokenCostThresholds: { green: number; yellow: number };
  setTokenCostThresholds: (v: { green: number; yellow: number }) => void;
  enableBacklog: boolean;
  setEnableBacklog: (v: boolean) => void;
  requireComment: boolean;
  setRequireComment: (v: boolean) => void;
  worktreeByDefault: boolean;
  setWorktreeByDefault: (v: boolean) => void;
  generateDistinctFiles: boolean;
  setGenerateDistinctFiles: (v: boolean) => void;
  releaseNotesPath: string;
  setReleaseNotesPath: (v: string) => void;
  boardFx: BoardFxConfig;
  setBoardFx: (v: BoardFxConfig) => void;
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
  commentHoverPreviewEnabled,
  setCommentHoverPreviewEnabled,
  tokenDisplayMode,
  setTokenDisplayMode,
  tokenCostThresholds,
  setTokenCostThresholds,
  enableBacklog,
  setEnableBacklog,
  requireComment,
  setRequireComment,
  worktreeByDefault,
  setWorktreeByDefault,
  generateDistinctFiles,
  setGenerateDistinctFiles,
  releaseNotesPath,
  setReleaseNotesPath,
  boardFx,
  setBoardFx,
}: PreferencesSectionProps) {
  const { setAppTheme } = useAppActions();
  const theme = useAppSelector(s => s.theme);

  const themeSwatches: Record<AppTheme, { base: string; accent: string; texture: string }> = {
    light: { base: '#f9fafb', accent: '#aa3bff', texture: '' },
    dark: { base: '#16171d', accent: '#aa3bff', texture: '' },
    matrix: { base: '#0a0f0a', accent: '#00e639', texture: 'repeating-linear-gradient(rgba(0,255,65,0.08) 0px, rgba(0,255,65,0.08) 1px, transparent 1px, transparent 12px), repeating-linear-gradient(90deg, rgba(0,255,65,0.08) 0px, rgba(0,255,65,0.08) 1px, transparent 1px, transparent 12px)' },
    cyber: { base: '#0d0b1a', accent: '#a78bfa', texture: 'repeating-linear-gradient(135deg, rgba(139,92,246,0.1) 0px, rgba(139,92,246,0.1) 1px, transparent 1px, transparent 8px)' },
    midnight: { base: '#0b1121', accent: '#38bdf8', texture: 'radial-gradient(circle, rgba(148,163,184,0.15) 1px, transparent 1px)' },
  };

  return (
    <div className="space-y-8">
      {/* Theme Picker */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Theme</h3>
          <p className="text-xs text-gray-500 mb-4 text-balance">Choose a visual theme that transforms colors, surfaces, and accents across the entire interface.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {THEMES.map((t) => {
            const swatch = themeSwatches[t.name];
            const isActive = theme === t.name;
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => setAppTheme(t.name)}
                className={`group relative flex flex-col items-center gap-2 rounded-xl p-3 transition-all border-2 ${isActive ? 'shadow-lg' : 'hover:scale-[1.02]'}`}
                style={{
                  borderColor: isActive ? swatch.accent : 'var(--eh-border)',
                  boxShadow: isActive ? `0 4px 20px ${swatch.accent}22` : undefined,
                }}
              >
                <div
                  className="w-24 h-16 rounded-lg overflow-hidden relative"
                  style={{ background: swatch.base }}
                >
                  {swatch.texture && (
                    <div className="absolute inset-0" style={{ backgroundImage: swatch.texture, backgroundSize: '12px 12px' }} />
                  )}
                  {/* Mini card preview */}
                  <div
                    className="absolute bottom-1.5 left-1.5 right-1.5 h-5 rounded-md border"
                    style={{
                      background: t.baseMode === 'dark' ? `${swatch.base}cc` : '#ffffffcc',
                      borderColor: `${swatch.accent}33`,
                      boxShadow: `0 0 8px ${swatch.accent}15`,
                    }}
                  />
                  {/* Accent dot */}
                  <div
                    className="absolute top-2 right-2 w-2 h-2 rounded-full"
                    style={{ background: swatch.accent }}
                  />
                </div>
                <span className="text-xs font-semibold" style={{ color: isActive ? swatch.accent : 'var(--eh-text-secondary)' }}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

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

      {/* Board FX */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Board FX</h3>
          <p className="text-xs text-gray-500 mb-4 text-balance">Ambient visual effects that make the board feel alive. All purely cosmetic — disable any that distract.</p>
        </div>
        <SettingToggleCard
          title="🔥 Column Fire"
          description="The card-count pill on a column header ignites as tickets pile up — warm amber at 7+, orange at 13+, red-hot at 20+."
          checked={boardFx.columnFire ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, columnFire: v })}
        />
        <SettingToggleCard
          title="🟫 Ticket Age Rust"
          description="Cards that haven't had any activity in 4+ days develop a subtle sepia tint that deepens over time. Active sessions never rust."
          checked={boardFx.ticketAgeRust ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, ticketAgeRust: v })}
        />
        <SettingToggleCard
          title="✨ Drag Trail Glow"
          description="The card you're dragging emits a soft indigo light pulse. Pure CSS — zero runtime overhead."
          checked={boardFx.dragTrail ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, dragTrail: v })}
        />
        <SettingToggleCard
          title="🌫️ Idle Column Dust"
          description="Empty columns show a faint drifting particle effect — a subtle 'cobwebs' hint that the column is waiting for work."
          checked={boardFx.idleDust ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, idleDust: v })}
        />
        <SettingToggleCard
          title="🌤️ Board Weather"
          description="A weather icon in the header reflects board health — sunny when flow is good, cloudy when tickets are stacking, stormy when things are blocked."
          checked={boardFx.boardWeather ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, boardWeather: v })}
        />
        <SettingToggleCard
          title="➡️ Column Flow Arrows"
          description="Thin animated arrows between column headers show where tickets have moved in the last 24h. Heavier arrow = more movement."
          checked={boardFx.columnFlowArrows ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, columnFlowArrows: v })}
        />
        <SettingToggleCard
          title="💓 Agent Heartbeat"
          description="A 1px strip at the top of the viewport pulses with the running agent's live token throughput. Flatlines when idle."
          checked={boardFx.heartbeat ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, heartbeat: v })}
        />
        <SettingToggleCard
          title="⚡ Speed Demon Badge"
          description="Tickets completed in under 2 hours earn a ⚡ badge on their Done card."
          checked={boardFx.speedDemon ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, speedDemon: v })}
        />
        <SettingToggleCard
          title="🔥 Done Streak"
          description="Tracks tickets completed today. Bronze at 3, gold at 5, platinum at 10, diamond at 15."
          checked={boardFx.doneStreak ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, doneStreak: v })}
        />
        <SettingToggleCard
          title="🧬 Ticket DNA"
          description="Each ticket shows a tiny unique waveform fingerprint derived from its ID — a visual identity so you recognise cards before reading them."
          checked={boardFx.ticketDna ?? true}
          onChange={(v) => setBoardFx({ ...boardFx, ticketDna: v })}
        />
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
          title="Comment Hover Preview"
          description="Open a card's comment popover when you hover its comment badge. Off by default — clicking the badge always opens it."
          checked={commentHoverPreviewEnabled}
          onChange={setCommentHoverPreviewEnabled}
        />

        <DesktopNotificationsCard />

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

        <SettingToggleCard
          title="Dedicated Worktree by Default"
          description="When starting a task with a branch, default the 'dedicated worktree' choice on — the agent runs in an isolated git worktree so master stays put and concurrent tasks never collide. Overridable per launch."
          checked={worktreeByDefault}
          onChange={setWorktreeByDefault}
        />

        <WorktreesPanel />

        <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Restart Onboarding Wizard</span>
              <span className="text-xs text-gray-500">Re-run the first-time setup wizard on next page reload.</span>
            </div>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('eh-onboarding-complete');
                window.location.reload();
              }}
              className="shrink-0 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
            >
              Restart Setup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
