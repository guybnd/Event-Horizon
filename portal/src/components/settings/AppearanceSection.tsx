import { THEMES, type AppTheme } from '../../AppContext';
import { useAppSelector, useAppActions } from '../../store/useAppSelector';
import { SettingToggleCard } from './shared';

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

/** The full set of ambient board effects, in display order. Derived data so the master
 *  toggle and the per-effect rows stay in sync from one source. */
const BOARD_FX_EFFECTS: { key: keyof BoardFxConfig; title: string; description: string }[] = [
  { key: 'columnFire', title: '🔥 Column Fire', description: 'The card-count pill on a column header ignites as tickets pile up — warm amber at 7+, orange at 13+, red-hot at 20+.' },
  { key: 'ticketAgeRust', title: '🟫 Ticket Age Rust', description: "Cards that haven't had any activity in 4+ days develop a subtle sepia tint that deepens over time. Active sessions never rust." },
  { key: 'dragTrail', title: '✨ Drag Trail Glow', description: "The card you're dragging emits a soft indigo light pulse. Pure CSS — zero runtime overhead." },
  { key: 'idleDust', title: '🌫️ Idle Column Dust', description: "Empty columns show a faint drifting particle effect — a subtle 'cobwebs' hint that the column is waiting for work." },
  { key: 'boardWeather', title: '🌤️ Board Weather', description: 'A weather icon in the header reflects board health — sunny when flow is good, cloudy when tickets are stacking, stormy when things are blocked.' },
  { key: 'columnFlowArrows', title: '➡️ Column Flow Arrows', description: 'Thin animated arrows between column headers show where tickets have moved in the last 24h. Heavier arrow = more movement.' },
  { key: 'heartbeat', title: '💓 Agent Heartbeat', description: "A 1px strip at the top of the viewport pulses with the running agent's live token throughput. Flatlines when idle." },
  { key: 'speedDemon', title: '⚡ Speed Demon Badge', description: 'Tickets completed in under 2 hours earn a ⚡ badge on their Done card.' },
  { key: 'doneStreak', title: '🔥 Done Streak', description: 'Tracks tickets completed today. Bronze at 3, gold at 5, platinum at 10, diamond at 15.' },
  { key: 'ticketDna', title: '🧬 Ticket DNA', description: 'Each ticket shows a tiny unique waveform fingerprint derived from its ID — a visual identity so you recognise cards before reading them.' },
];

interface AppearanceSectionProps {
  animationsEnabled: boolean;
  setAnimationsEnabled: (v: boolean) => void;
  animationSpeed: 'fast' | 'normal' | 'slow';
  setAnimationSpeed: (v: 'fast' | 'normal' | 'slow') => void;
  enableFireworks: boolean;
  setEnableFireworks: (v: boolean) => void;
  boardFx: BoardFxConfig;
  setBoardFx: (v: BoardFxConfig) => void;
}

export function AppearanceSection({
  animationsEnabled,
  setAnimationsEnabled,
  animationSpeed,
  setAnimationSpeed,
  enableFireworks,
  setEnableFireworks,
  boardFx,
  setBoardFx,
}: AppearanceSectionProps) {
  const { setAppTheme } = useAppActions();
  const theme = useAppSelector(s => s.theme);

  const themeSwatches: Record<AppTheme, { base: string; accent: string; texture: string }> = {
    light: { base: '#f9fafb', accent: '#aa3bff', texture: '' },
    dark: { base: '#16171d', accent: '#aa3bff', texture: '' },
    matrix: { base: '#0a0f0a', accent: '#00e639', texture: 'repeating-linear-gradient(rgba(0,255,65,0.08) 0px, rgba(0,255,65,0.08) 1px, transparent 1px, transparent 12px), repeating-linear-gradient(90deg, rgba(0,255,65,0.08) 0px, rgba(0,255,65,0.08) 1px, transparent 1px, transparent 12px)' },
    cyber: { base: '#0d0b1a', accent: '#a78bfa', texture: 'repeating-linear-gradient(135deg, rgba(139,92,246,0.1) 0px, rgba(139,92,246,0.1) 1px, transparent 1px, transparent 8px)' },
    midnight: { base: '#0b1121', accent: '#38bdf8', texture: 'radial-gradient(circle, rgba(148,163,184,0.15) 1px, transparent 1px)' },
  };

  const fxAnyOn = BOARD_FX_EFFECTS.some(({ key }) => boardFx[key] ?? true);
  const setAllFx = (value: boolean) => {
    setBoardFx(Object.fromEntries(BOARD_FX_EFFECTS.map(({ key }) => [key, value])) as BoardFxConfig);
  };

  return (
    <div className="space-y-10">
      {/* Theme */}
      <section className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Theme</h3>
          <p className="text-xs text-gray-500 mb-4 text-balance">Choose a visual theme that transforms colors, surfaces, and accents across the entire interface. Applies instantly.</p>
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
                  <div
                    className="absolute bottom-1.5 left-1.5 right-1.5 h-5 rounded-md border"
                    style={{
                      background: t.baseMode === 'dark' ? `${swatch.base}cc` : '#ffffffcc',
                      borderColor: `${swatch.accent}33`,
                      boxShadow: `0 0 8px ${swatch.accent}15`,
                    }}
                  />
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
      </section>

      {/* Animations */}
      <section className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Animations</h3>
          <p className="text-xs text-gray-500 mb-4 text-balance">Motion and celebratory flourishes across the board and ticket views.</p>
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
      </section>

      {/* Board FX */}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Board FX</h3>
            <p className="text-xs text-gray-500 text-balance">Ambient visual effects that make the board feel alive. All purely cosmetic — disable any that distract, or flip them all at once.</p>
          </div>
          <button
            type="button"
            onClick={() => setAllFx(!fxAnyOn)}
            className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
          >
            {fxAnyOn ? 'Disable all FX' : 'Enable all FX'}
          </button>
        </div>
        {BOARD_FX_EFFECTS.map(({ key, title, description }) => (
          <SettingToggleCard
            key={key}
            title={title}
            description={description}
            checked={boardFx[key] ?? true}
            onChange={(v) => setBoardFx({ ...boardFx, [key]: v })}
          />
        ))}
      </section>
    </div>
  );
}
