import type { ReactNode } from 'react';

// Shared card-pill contract (FLUX-652): one fixed height, one radius, one padding scale, and a
// bounded width so every chip grows symmetrically WITHIN its constraint and can never push the
// card wider. Interactive chips (buttons) compose this string directly; static chips use the
// <CardChip> wrapper below. The actual text node still needs `truncate` to clip — see CARD_CHIP_TEXT.
export const CARD_CHIP_BASE =
  'inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded px-1.5 text-[10px] font-medium';

// Apply to the text node inside a chip so a long value ellipsis-clips instead of widening the chip.
export const CARD_CHIP_TEXT = 'min-w-0 truncate';

/** Static (non-interactive) chip. For buttons, spread CARD_CHIP_BASE onto the element instead. */
export function CardChip({
  children,
  className = '',
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={`${CARD_CHIP_BASE} ${className}`} title={title}>
      {children}
    </span>
  );
}
