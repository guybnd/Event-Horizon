import { useCallback, useMemo } from 'react';
import { X } from 'lucide-react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { GateName, GateValue } from '../types';
import {
  GATE_POLICY_PRESET_LABEL,
  GATE_POLICY_PRESET_ORDER,
  countGatePolicyOverrides,
  gatePolicyPresetBoardDefault,
  matchGatePolicyPreset,
  type GatePolicyPreset,
} from '../lib/gatePolicyPresets';
import { SettingToggleCard } from './settings/shared';

const GATE_LABEL: Record<GateName, string> = {
  plan: 'Plan review',
  review: 'Code review',
};

const GATE_VALUE_LABEL: Record<GateValue, string> = {
  auto: 'Auto',
  'auto-then-you': 'Auto → You',
  you: 'You',
};

// FLUX-1261: live per-option description shown under the segmented control, so picking a value
// tells you exactly what it does before you commit to it (prototyped in the parent epic's rev 3
// artifact). Only `review`'s `auto` is wired to real runtime behavior right now (Temper's existing
// loop, re-gated off this schema) — the other combinations are schema-and-UI only until the
// generalized loop-driver ("Plan-review runner" subtask) lands.
const GATE_VALUE_DESCRIPTION: Record<GateName, Record<GateValue, string>> = {
  plan: {
    auto: 'Grooming auto-reviews the plan and loops back for changes until it’s approved, then moves straight to Todo — no click. Parks for you if it can’t converge after a few attempts.',
    'auto-then-you': 'Loops review → revise until the plan is approved (or parks at the retry cap), then flags you to confirm the move to Todo.',
    you: 'Always waits for you to review the plan and move it to Todo yourself — no automated pass runs.',
  },
  review: {
    auto: 'A ticket with a branch that reaches Ready is auto-reviewed and loops review → re-implementation until approved (PR left open, never merged) — or parks for you after a few attempts. This is Temper.',
    'auto-then-you': 'One review session runs, then it always stops and flags you with its verdict — it never loops on its own.',
    you: 'Always waits for you to review — no automated pass runs.',
  },
};

// FLUX-1263: the `plan` gate's review depth/breadth — a column-level fixed override of the
// effort-based auto-pick (Quick/Standard/Thorough), dialed here alongside the gate value itself.
type PlanReviewDepthSetting = 'auto' | 'quick' | 'standard' | 'thorough';

const DEPTH_LABEL: Record<PlanReviewDepthSetting, string> = {
  auto: 'Auto (by effort)',
  quick: 'Quick',
  standard: 'Standard',
  thorough: 'Thorough',
};

const DEPTH_DESCRIPTION: Record<PlanReviewDepthSetting, string> = {
  auto: "Picks the depth from the ticket's effort: XS/S → Quick, M → Standard, L/XL → Thorough.",
  quick: 'Anchor-existence check only, reground skipped — forced for every plan review regardless of effort.',
  standard: 'Anchor check + reground (release notes + sibling tickets) + acceptance-criteria coverage.',
  thorough: 'Everything Standard does, plus a duplicate-ticket check and an adversarial self-review pass.',
};

interface GatePolicyModalProps {
  gate: GateName;
  onClose: () => void;
}

export function GatePolicyModal({ gate, onClose }: GatePolicyModalProps) {
  const config = useAppSelector((s) => s.config);
  const tasks = useAppSelector((s) => s.tasks);
  const { saveConfig } = useAppActions();
  useEscapeKey(onClose, { ignoreWhenTyping: false });

  const current: GateValue = config?.gatePolicy?.boardDefault?.[gate] ?? 'you';

  const setValue = useCallback((value: GateValue) => {
    if (!config || value === current) return;
    void saveConfig({
      ...config,
      gatePolicy: {
        boardDefault: {
          plan: config.gatePolicy?.boardDefault?.plan ?? 'you',
          review: config.gatePolicy?.boardDefault?.review ?? 'you',
          [gate]: value,
        },
      },
    });
  }, [config, current, gate, saveConfig]);

  // FLUX-1264: one-click presets over BOTH gates at once. Applying one only ever writes
  // `boardDefault` — a ticket's own `gatePolicyOverride` (if any) is a completely separate object
  // on that ticket's frontmatter, so a preset can never clear it (non-destructive by construction).
  const activePreset = matchGatePolicyPreset(config?.gatePolicy?.boardDefault);
  const overrideCount = useMemo(() => countGatePolicyOverrides(tasks), [tasks]);

  const applyPreset = useCallback((preset: GatePolicyPreset) => {
    if (!config || preset === activePreset) return;
    void saveConfig({ ...config, gatePolicy: { boardDefault: gatePolicyPresetBoardDefault(preset) } });
  }, [config, activePreset, saveConfig]);

  const currentDepth: PlanReviewDepthSetting = (config?.planReviewDepth as PlanReviewDepthSetting | undefined) ?? 'auto';

  const setDepth = useCallback((value: PlanReviewDepthSetting) => {
    if (!config || value === currentDepth) return;
    void saveConfig({ ...config, planReviewDepth: value });
  }, [config, currentDepth, saveConfig]);

  // FLUX-1290: plain on/off, not a `gatePolicy` key — `merge` stays structurally unrepresentable
  // in `GateValue`. Dialed here (review gate) since it's the same "→ Ready merge" concern.
  const blockAgentPrMerges = config?.blockAgentPrMerges ?? false;

  const setBlockAgentPrMerges = useCallback((value: boolean) => {
    if (!config || value === blockAgentPrMerges) return;
    void saveConfig({ ...config, blockAgentPrMerges: value });
  }, [config, blockAgentPrMerges, saveConfig]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white dark:bg-[#1a1b23] border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-white/5 shrink-0">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{GATE_LABEL[gate]} gate</h2>
          <button
            onClick={onClose}
            className="p-2 -mr-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="pb-4 border-b border-gray-100 dark:border-white/5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">Presets — both gates</span>
              <span
                className={`text-[11px] font-medium ${overrideCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}
                title="Tickets with their own gatePolicyOverride keep it — presets only change the board default."
              >
                {overrideCount} ticket{overrideCount === 1 ? '' : 's'} override this
              </span>
            </div>
            <div className="flex w-full rounded-xl overflow-hidden border border-gray-200 dark:border-white/10">
              {GATE_POLICY_PRESET_ORDER.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  aria-pressed={activePreset === preset}
                  className={`flex-1 px-3 py-2 text-sm font-bold transition-colors ${
                    activePreset === preset
                      ? 'bg-primary text-white'
                      : 'bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10'
                  }`}
                >
                  {GATE_POLICY_PRESET_LABEL[preset]}
                </button>
              ))}
            </div>
            {!activePreset && (
              <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">Custom — plan and review are dialed independently below.</p>
            )}
          </div>

          <div className="flex w-full rounded-xl overflow-hidden border border-gray-200 dark:border-white/10">
            {(['auto', 'auto-then-you', 'you'] as GateValue[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setValue(value)}
                aria-pressed={current === value}
                className={`flex-1 px-3 py-2 text-sm font-bold transition-colors ${
                  current === value
                    ? 'bg-primary text-white'
                    : 'bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10'
                }`}
              >
                {GATE_VALUE_LABEL[value]}
              </button>
            ))}
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed min-h-[3.5rem]">
            {GATE_VALUE_DESCRIPTION[gate][current]}
          </p>

          {gate === 'plan' && (
            <div className="pt-2 border-t border-gray-100 dark:border-white/5">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">Review depth</div>
              <div className="flex w-full rounded-xl overflow-hidden border border-gray-200 dark:border-white/10">
                {(['auto', 'quick', 'standard', 'thorough'] as PlanReviewDepthSetting[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDepth(value)}
                    aria-pressed={currentDepth === value}
                    className={`flex-1 px-2 py-2 text-xs font-bold transition-colors ${
                      currentDepth === value
                        ? 'bg-primary text-white'
                        : 'bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10'
                    }`}
                  >
                    {DEPTH_LABEL[value]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300 leading-relaxed min-h-[3.5rem]">
                {DEPTH_DESCRIPTION[currentDepth]}
              </p>
            </div>
          )}

          {gate === 'review' && (
            <div className="pt-2 border-t border-gray-100 dark:border-white/5">
              <SettingToggleCard
                title="Block agent PR merges"
                description="Off (default): an agent session can merge a branch/PR ticket via finish_ticket with no prior human touch — e.g. an explicitly-requested batch merge sweep. On: restores the always-on merge-lock — finish_ticket refuses until a human has commented, reviewed, or moved the ticket's status."
                checked={blockAgentPrMerges}
                onChange={setBlockAgentPrMerges}
              />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-black/10 shrink-0 flex justify-end rounded-b-2xl">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors rounded-xl"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
