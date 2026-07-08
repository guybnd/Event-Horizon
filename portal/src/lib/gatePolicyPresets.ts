/**
 * One-click board-default presets over `config.gatePolicy.boardDefault` (FLUX-1264, sibling
 * "presets + merge-lock" subtask, parent epic FLUX-1247). Pure UI convenience over the existing
 * `gatePolicy` schema (FLUX-1261) — applying a preset just writes `boardDefault`, same as dialing
 * each gate individually in `GatePolicyModal`. `merge` is never touched by any preset: it isn't a
 * representable key in `GateValue`/`GatePolicy` at all (the merge-lock is structural, engine-side).
 */

import type { GateName, GateValue, Task } from '../types';

export type GatePolicyPreset = 'manual' | 'guided' | 'autonomous';

export const GATE_POLICY_PRESET_ORDER: readonly GatePolicyPreset[] = ['manual', 'guided', 'autonomous'] as const;

export const GATE_POLICY_PRESETS: Record<GatePolicyPreset, Record<GateName, GateValue>> = {
  manual: { plan: 'you', review: 'you' },
  guided: { plan: 'auto-then-you', review: 'auto-then-you' },
  autonomous: { plan: 'auto', review: 'auto' },
};

export const GATE_POLICY_PRESET_LABEL: Record<GatePolicyPreset, string> = {
  manual: 'Manual',
  guided: 'Guided',
  autonomous: 'Autonomous',
};

/**
 * Which preset (if any) `boardDefault` exactly matches — `null` means a custom mix the three
 * presets don't cover (e.g. `plan: auto, review: you`). That's a fully legitimate board state;
 * it just means none of the three preset buttons should render as active.
 */
export function matchGatePolicyPreset(
  boardDefault: Partial<Record<GateName, GateValue>> | null | undefined,
): GatePolicyPreset | null {
  if (!boardDefault) return null;
  const match = GATE_POLICY_PRESET_ORDER.find((preset) => {
    const value = GATE_POLICY_PRESETS[preset];
    return boardDefault.plan === value.plan && boardDefault.review === value.review;
  });
  return match ?? null;
}

/**
 * Non-destructive apply (acceptance criterion): a preset only ever writes `boardDefault` — it must
 * never clear a ticket's own `gatePolicyOverride`. Since presets and overrides live on separate
 * objects (board config vs. ticket frontmatter) this holds structurally as long as callers only
 * spread this into `gatePolicy.boardDefault`, never touch tickets. Counting how many tickets carry
 * an override (below) is what makes that non-destructiveness visible rather than silently stale.
 */
export function gatePolicyPresetBoardDefault(preset: GatePolicyPreset): Record<GateName, GateValue> {
  return { ...GATE_POLICY_PRESETS[preset] };
}

/** How many (active) tickets carry a per-ticket `gatePolicyOverride` for either gate — a preset
 *  change never touches these, so surfacing the count is what keeps a stale override from being
 *  silently confusing after a board-wide preset change. */
export function countGatePolicyOverrides(tasks: readonly Task[] | null | undefined): number {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) => t.gatePolicyOverride?.plan != null || t.gatePolicyOverride?.review != null).length;
}
