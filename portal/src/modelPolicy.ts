import type { CliFramework, ModelPreset, TaskKey, Tier } from './types';

export type TierModels = { smart: string; efficient: string; cheap: string };

export const TIERS: Tier[] = ['smart', 'efficient', 'cheap'];

export const TASK_KEY_GROUPS: { phase: string; keys: TaskKey[] }[] = [
  { phase: 'Grooming', keys: ['grooming.lead', 'grooming.workers'] },
  { phase: 'Plan review', keys: ['planReview'] },
  { phase: 'Implementation', keys: ['implementation.lead', 'implementation.workers'] },
  { phase: 'Review', keys: ['review.lead', 'review.workers'] },
  { phase: 'Finalize', keys: ['finalize'] },
  { phase: 'Chat', keys: ['chat'] },
];

export const TASK_KEYS: TaskKey[] = TASK_KEY_GROUPS.flatMap((g) => g.keys);

export const TASK_KEY_LABELS: Record<TaskKey, string> = {
  'grooming.lead': 'Grooming — lead',
  'grooming.workers': 'Grooming — workers',
  planReview: 'Plan-gate review',
  'implementation.lead': 'Implementation — lead',
  'implementation.workers': 'Implementation — workers',
  'review.lead': 'Review — lead / synthesizer',
  'review.workers': 'Review — workers',
  finalize: 'Finalize',
  chat: 'Chat',
};

/** Pinned preset tables (FLUX-1373 plan). Balanced is the shipped default. */
export const PRESET_ASSIGNMENTS: Record<Exclude<ModelPreset, 'custom'>, Record<TaskKey, Tier>> = {
  splurge: {
    'grooming.lead': 'smart',
    'grooming.workers': 'smart',
    planReview: 'smart',
    'implementation.lead': 'smart',
    'implementation.workers': 'smart',
    'review.lead': 'smart',
    'review.workers': 'smart',
    finalize: 'smart',
    chat: 'smart',
  },
  balanced: {
    'grooming.lead': 'smart',
    'grooming.workers': 'efficient',
    planReview: 'smart',
    'implementation.lead': 'efficient',
    'implementation.workers': 'efficient',
    'review.lead': 'smart',
    'review.workers': 'efficient',
    finalize: 'cheap',
    chat: 'efficient',
  },
  frugal: {
    'grooming.lead': 'efficient',
    'grooming.workers': 'cheap',
    planReview: 'efficient',
    'implementation.lead': 'efficient',
    'implementation.workers': 'cheap',
    'review.lead': 'efficient',
    'review.workers': 'cheap',
    finalize: 'cheap',
    chat: 'cheap',
  },
};

/** Placeholder model ids shown when a tier's field is blank (shipped defaults, mirrors engine config.ts). */
export const DEFAULT_TIER_MODELS: Record<CliFramework, TierModels> = {
  claude: { smart: 'opus', efficient: 'sonnet', cheap: 'haiku' },
  gemini: { smart: 'gemini-2.5-pro', efficient: 'gemini-2.5-flash', cheap: 'gemini-2.5-flash-lite' },
  copilot: { smart: 'gpt-5', efficient: 'gpt-5-mini', cheap: 'gpt-4.1' },
};

export const EMPTY_TIER_MODELS: TierModels = { smart: '', efficient: '', cheap: '' };

/** Derives the active preset chip: 'custom' whenever assignments diverge from all three named tables. */
export function derivePreset(assignments: Record<TaskKey, Tier>): ModelPreset {
  for (const preset of ['splurge', 'balanced', 'frugal'] as const) {
    const table = PRESET_ASSIGNMENTS[preset];
    if (TASK_KEYS.every((key) => assignments[key] === table[key])) return preset;
  }
  return 'custom';
}

/** Pure client-side mirror of the engine's `resolveModel(taskKey, framework, config)` — for the
 *  task-list's live resolved-model preview only, no API call. */
export function resolveModel(
  taskKey: TaskKey,
  framework: CliFramework,
  tiers: TierModels,
  assignments: Record<TaskKey, Tier>
): string {
  const tier = assignments[taskKey];
  return tiers[tier]?.trim() || DEFAULT_TIER_MODELS[framework][tier];
}
