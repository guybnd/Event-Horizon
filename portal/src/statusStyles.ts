import type { Config } from './types';

export const STATUS_COLOR_PALETTE = [
  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
];

export function getDefaultStatusColor(statusName: string | undefined) {
  if (!statusName) return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  const normalized = statusName.trim().toLowerCase();

  if (normalized === 'done') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  }

  if (normalized === 'in progress') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  }

  if (normalized === 'require input' || normalized === 'ready') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  }

  if (normalized === 'grooming') {
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300';
  }

  if (normalized === 'todo') {
    return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300';
  }

  if (normalized === 'backlog') {
    return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }

  return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
}

export function getStatusColorClass(config: Config | null | undefined, statusName: string | undefined) {
  if (!statusName) return getDefaultStatusColor('unknown');
  const normalized = statusName.trim().toLowerCase();
  const configuredStatus = [...(config?.columns || []), ...(config?.hiddenStatuses || [])]
    .find((item) => item.name?.trim().toLowerCase() === normalized);

  return configuredStatus?.color || getDefaultStatusColor(statusName);
}

/**
 * Per-column color identity ("full wash").
 *
 * IMPORTANT: `.eh-card`/`.eh-column` set `background`/`border-color` as UNLAYERED
 * rules, which (in Tailwind v4) always beat layered `bg-*`/`border-*` utilities.
 * So the wash + card tint are applied as INLINE styles built from an rgb triplet
 * (inline always wins, and a translucent layer over the theme's own background is
 * inherently theme-aware). Only `accent` stays a utility class — it lives on a
 * child element with no `.eh-card` override to fight.
 *
 * - `accent`: column header accent bar (utility class — safe on a child span)
 * - `rgb`:    base hue as "r, g, b"; alpha applied per-surface inline
 */
export interface StatusTint {
  hue: string;
  accent: string;
  rgb: string;
}

const HUES = ['gray', 'orange', 'amber', 'emerald', 'blue', 'sky', 'purple', 'pink', 'indigo', 'rose', 'teal'] as const;
type Hue = (typeof HUES)[number];

const STATUS_TINTS: Record<Hue, StatusTint> = {
  gray: { hue: 'gray', accent: 'bg-gray-400 dark:bg-gray-500', rgb: '107, 114, 128' },
  orange: { hue: 'orange', accent: 'bg-orange-400 dark:bg-orange-500', rgb: '249, 115, 22' },
  amber: { hue: 'amber', accent: 'bg-amber-400 dark:bg-amber-500', rgb: '245, 158, 11' },
  emerald: { hue: 'emerald', accent: 'bg-emerald-400 dark:bg-emerald-500', rgb: '16, 185, 129' },
  blue: { hue: 'blue', accent: 'bg-blue-400 dark:bg-blue-500', rgb: '59, 130, 246' },
  sky: { hue: 'sky', accent: 'bg-sky-400 dark:bg-sky-500', rgb: '14, 165, 233' },
  purple: { hue: 'purple', accent: 'bg-purple-400 dark:bg-purple-500', rgb: '168, 85, 247' },
  pink: { hue: 'pink', accent: 'bg-pink-400 dark:bg-pink-500', rgb: '236, 72, 153' },
  indigo: { hue: 'indigo', accent: 'bg-indigo-400 dark:bg-indigo-500', rgb: '99, 102, 241' },
  rose: { hue: 'rose', accent: 'bg-rose-400 dark:bg-rose-500', rgb: '244, 63, 94' },
  teal: { hue: 'teal', accent: 'bg-teal-400 dark:bg-teal-500', rgb: '20, 184, 166' },
};

/** Extract the Tailwind hue family (e.g. "sky") from a status color class string. */
function hueFromColorClass(colorClass: string): Hue {
  const match = colorClass.match(/bg-([a-z]+)-\d/);
  const found = match?.[1] as Hue | undefined;
  return found && HUES.includes(found) ? found : 'gray';
}

/** Resolve the per-column tint for a status, from config or defaults. */
export function getStatusTint(config: Config | null | undefined, statusName: string | undefined): StatusTint {
  const colorClass = getStatusColorClass(config, statusName);
  return STATUS_TINTS[hueFromColorClass(colorClass)];
}

/** Flat translucent fill for a tint surface — built so it wins over unlayered .eh-* rules. */
export function tintFill(tint: StatusTint, alpha: number): string {
  return `linear-gradient(rgba(${tint.rgb}, ${alpha}), rgba(${tint.rgb}, ${alpha}))`;
}

/**
 * Soft glow for the column wash: a radial bloom anchored at the top-center
 * (under the header, where the column identity lives) that feathers out toward
 * every edge — left, right and bottom — so the color dissolves into the shared
 * base rather than filling a hard-edged rectangle. `peak` is the alpha at the
 * brightest point.
 */
export function tintColumnWash(tint: StatusTint, peak: number): string {
  return `radial-gradient(135% 70% at 50% -10%, rgba(${tint.rgb}, ${peak}) 0%, rgba(${tint.rgb}, ${peak * 0.35}) 35%, rgba(${tint.rgb}, 0) 75%)`;
}