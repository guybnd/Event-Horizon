/**
 * FLUX-1281: the dock bar's shared icon-first / hover-reveal-label pattern (Board / New Scratch /
 * Furnace / Attention Dock). The outer button gets `group relative` and NO overflow-hidden — only
 * the label slot below clips itself for the collapse animation, so corner badges (which must be
 * DIRECT children of the button, anchored to its own box) are never cropped and track the button's
 * true edge as the label expands (the rev-3/4 clipping bug). `focus-visible` mirrors hover so every
 * reveal has a keyboard equivalent.
 */
export const DOCK_REVEAL_LABEL =
  'max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ' +
  'group-hover:max-w-[130px] group-hover:pr-2.5 group-hover:opacity-100 ' +
  'group-focus-visible:max-w-[130px] group-focus-visible:pr-2.5 group-focus-visible:opacity-100';

/** The fixed-width icon slot the label reveals beside — centers the glyph in the button's square. */
export const DOCK_ICON_SLOT = 'flex h-9 w-9 flex-shrink-0 items-center justify-center';
