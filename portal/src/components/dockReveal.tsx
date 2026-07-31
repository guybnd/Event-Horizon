/**
 * FLUX-1281: the dock bar's shared icon-first pattern (Orchestrator / New Scratch / Furnace /
 * Attention Dock). The outer button gets `group relative` — corner badges (which must be DIRECT
 * children of the button, anchored to its own box) track the button's true edge.
 *
 * FLUX-1619: the old hover/focus label reveal (`DOCK_REVEAL_LABEL`, retired) grew the button
 * sideways and shoved every sibling to the right. It's replaced by `DockTooltip` below — a
 * floating, label-only popup absolutely positioned above the button, so the button itself never
 * resizes on hover/focus.
 */

/** The fixed-width icon slot the button centers its glyph in. */
export const DOCK_ICON_SLOT = 'flex h-9 w-9 flex-shrink-0 items-center justify-center';

/**
 * Floating hover/focus tooltip showing just a label — styled after the Furnace icon's existing
 * hover-flyout popup chrome (`eh-border eh-surface rounded-xl border shadow-2xl`), but plain text
 * with no menu items or click actions. `focus-visible` mirrors hover so keyboard users get the
 * same reveal. The parent button MUST carry `group relative`.
 */
export function DockTooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      aria-hidden="true"
      className="eh-border eh-surface pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-xl border px-2.5 py-1.5 text-xs font-medium opacity-0 shadow-2xl transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {label}
    </span>
  );
}
