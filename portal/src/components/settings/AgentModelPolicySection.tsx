import { useState } from 'react';
import { Bot, Zap, Terminal } from 'lucide-react';
import type { CliFramework, ModelPreset, TaskKey, Tier } from '../../types';
import {
  DEFAULT_TIER_MODELS,
  PRESET_ASSIGNMENTS,
  TASK_KEY_GROUPS,
  TASK_KEY_LABELS,
  TIERS,
  derivePreset,
  resolveModel,
  type TierModels,
} from '../../modelPolicy';

interface AgentModelPolicySectionProps {
  claudeTiers: TierModels;
  setClaudeTiers: (v: TierModels) => void;
  geminiTiers: TierModels;
  setGeminiTiers: (v: TierModels) => void;
  copilotTiers: TierModels;
  setCopilotTiers: (v: TierModels) => void;
  assignments: Record<TaskKey, Tier>;
  setAssignments: (v: Record<TaskKey, Tier>) => void;
}

const CLI_COLUMNS: { id: CliFramework; label: string; icon: typeof Bot }[] = [
  { id: 'claude', label: 'Claude', icon: Bot },
  { id: 'gemini', label: 'Gemini', icon: Zap },
  { id: 'copilot', label: 'Copilot', icon: Terminal },
];

const PRESET_CHIPS: { id: Exclude<ModelPreset, 'custom'>; label: string; blurb: string }[] = [
  { id: 'splurge', label: 'Splurge', blurb: 'Smart everywhere — spend for maximum quality' },
  { id: 'balanced', label: 'Balanced', blurb: 'Smart where judgment compounds, efficient where token volume lives' },
  { id: 'frugal', label: 'Frugal', blurb: 'Cheap by default, efficient only where it matters' },
];

/** FLUX-1373: replaces the old per-framework "Claude Code Models" / "Gemini CLI Models" cards.
 *  All three CLIs are always visible — no gating on the install-target selector. */
export function AgentModelPolicySection({
  claudeTiers,
  setClaudeTiers,
  geminiTiers,
  setGeminiTiers,
  copilotTiers,
  setCopilotTiers,
  assignments,
  setAssignments,
}: AgentModelPolicySectionProps) {
  const [previewCli, setPreviewCli] = useState<CliFramework>('claude');
  const activePreset = derivePreset(assignments);

  const tiersByFramework: Record<CliFramework, TierModels> = { claude: claudeTiers, gemini: geminiTiers, copilot: copilotTiers };
  const setTiersByFramework: Record<CliFramework, (v: TierModels) => void> = { claude: setClaudeTiers, gemini: setGeminiTiers, copilot: setCopilotTiers };

  const applyPreset = (preset: Exclude<ModelPreset, 'custom'>) => setAssignments({ ...PRESET_ASSIGNMENTS[preset] });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Model Policy</h3>
        <p className="text-xs text-gray-500 mb-2 text-balance">
          Assign each agent task a spend tier (Smart / Efficient / Cheap); each CLI defines what those tiers resolve to.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PRESET_CHIPS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(p.id)}
            title={p.blurb}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition-colors ${activePreset === p.id ? 'bg-primary text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10'}`}
          >
            {p.label}
          </button>
        ))}
        <span
          title="Custom is derived — editing any task assignment below moves you here, it isn't a table you can click"
          className={`rounded-full px-4 py-1.5 text-xs font-bold ${activePreset === 'custom' ? 'bg-primary text-white shadow-sm' : 'bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-gray-500'}`}
        >
          Custom
        </span>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Per-CLI tier definitions</h4>
        <p className="text-xs text-gray-500 mb-4">Model id passed via <code className="text-xs font-mono">--model</code>. Blank uses the shipped default shown as the placeholder.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400">
                <th className="pb-2 pr-4">Tier</th>
                {CLI_COLUMNS.map((c) => (
                  <th key={c.id} className="pb-2 pr-4">
                    <span className="inline-flex items-center gap-1.5"><c.icon className="h-3.5 w-3.5" />{c.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TIERS.map((tier) => (
                <tr key={tier}>
                  <td className="py-1.5 pr-4 text-xs font-semibold capitalize text-gray-600 dark:text-gray-300">{tier}</td>
                  {CLI_COLUMNS.map((c) => {
                    const tiers = tiersByFramework[c.id];
                    const setTiers = setTiersByFramework[c.id];
                    return (
                      <td key={c.id} className="py-1.5 pr-4">
                        <input
                          type="text"
                          value={tiers[tier]}
                          onChange={(e) => setTiers({ ...tiers, [tier]: e.target.value })}
                          placeholder={DEFAULT_TIER_MODELS[c.id][tier]}
                          className="w-full min-w-[10rem] rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-mono outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Task &rarr; tier assignment</h4>
            <p className="text-xs text-gray-500">Editing any row switches the preset above to Custom.</p>
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20">
            {CLI_COLUMNS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setPreviewCli(c.id)}
                title="Preview which literal model this CLI would run for each row"
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${previewCli === c.id ? 'bg-primary text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {TASK_KEY_GROUPS.map((group) => (
            <div key={group.phase}>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">{group.phase}</div>
              <div className="space-y-1.5">
                {group.keys.map((key) => (
                  <div key={key} className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-3 py-1.5 dark:border-white/5 dark:bg-black/20">
                    <span className="flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-300">{TASK_KEY_LABELS[key]}</span>
                    <select
                      value={assignments[key]}
                      onChange={(e) => setAssignments({ ...assignments, [key]: e.target.value as Tier })}
                      className="w-32 shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium capitalize outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
                    >
                      {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <span className="w-40 shrink-0 truncate text-right font-mono text-[11px] text-gray-500 dark:text-gray-400" title="Resolved model for the previewed CLI">
                      {resolveModel(key, previewCli, tiersByFramework[previewCli], assignments)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
