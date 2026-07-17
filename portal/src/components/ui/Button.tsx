import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Shared action-row button (FLUX-1477). One `filled` per row is the safe-forward action for the
 * context; `quiet` is a bordered/tinted secondary; `ghost` is a bare-text tertiary/dismiss action.
 * `intent` carries the semantic color: `accent` (the board's primary color), `approve`/`warn`/`danger`
 * (the FLUX-1478 `--eh-state-*` run-state tokens), `neutral` (no color — cancel/dismiss/link actions).
 */
export type ButtonVariant = 'filled' | 'quiet' | 'ghost';
export type ButtonIntent = 'accent' | 'approve' | 'warn' | 'danger' | 'neutral';
export type ButtonSize = 'sm' | 'md' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  intent?: ButtonIntent;
  size?: ButtonSize;
  /** Leading icon — replaced by a spinner while `busy`. */
  icon?: ReactNode;
  /** Shows a spinner in place of `icon` and disables the button. */
  busy?: boolean;
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'gap-1 rounded-lg px-2 py-1 text-[12px]',
  md: 'gap-1.5 rounded-lg px-3 py-1.5 text-[12px]',
  icon: 'rounded p-1',
};

// One accent color per intent, mirroring `--eh-accent` and the FLUX-1478 `--eh-state-*` tokens.
// `quietText` keeps the Tailwind palette shade already used at every pre-migration quiet-variant call
// site (a bare state token isn't a readable foreground on its own tinted/bordered background) — these
// happen to be the exact same hex values as the state tokens (emerald-500/amber-500/red-500), so this
// is pure normalization, not a color change.
const INTENT_COLOR: Record<Exclude<ButtonIntent, 'neutral'>, { bg: string; bgHover: string; quietText: string; quietBorder: string }> = {
  accent: {
    bg: 'bg-primary', bgHover: 'hover:bg-primary-hover', quietText: 'text-primary',
    quietBorder: 'border border-primary/40 hover:bg-primary/10',
  },
  approve: {
    bg: 'bg-[var(--eh-state-success)]', bgHover: 'hover:bg-[var(--eh-state-success-hover)]',
    quietText: 'text-emerald-700 dark:text-emerald-300',
    quietBorder: 'border border-[var(--eh-state-success)]/40 hover:bg-[var(--eh-state-success)]/10',
  },
  warn: {
    bg: 'bg-[var(--eh-state-attention)]', bgHover: 'hover:bg-[var(--eh-state-attention-hover)]',
    quietText: 'text-amber-700 dark:text-amber-300',
    quietBorder: 'border border-[var(--eh-state-attention)]/40 hover:bg-[var(--eh-state-attention)]/10',
  },
  danger: {
    bg: 'bg-[var(--eh-state-danger)]', bgHover: 'hover:bg-[var(--eh-state-danger-hover)]',
    quietText: 'text-red-700 dark:text-red-300',
    quietBorder: 'border border-[var(--eh-state-danger)]/40 hover:bg-[var(--eh-state-danger)]/10',
  },
};

function colorClasses(variant: ButtonVariant, intent: ButtonIntent): string {
  if (intent === 'neutral') {
    switch (variant) {
      case 'filled':
        return 'bg-[var(--eh-border)] text-[var(--eh-text-primary)] hover:bg-[var(--eh-text-muted)]/30';
      case 'quiet':
        return 'eh-border border text-[var(--eh-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5';
      case 'ghost':
      default:
        return 'text-[var(--eh-text-muted)] hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5';
    }
  }
  const c = INTENT_COLOR[intent];
  switch (variant) {
    case 'filled':
      return `${c.bg} text-white ${c.bgHover}`;
    case 'quiet':
      return `${c.quietBorder} ${c.quietText}`;
    case 'ghost':
    default:
      return `${c.quietText} hover:bg-black/5 dark:hover:bg-white/5`;
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'quiet', intent = 'neutral', size = 'md', icon, busy, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  const leading = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      className={[
        'inline-flex items-center justify-center font-semibold transition-colors disabled:opacity-40',
        SIZE_CLASSES[size],
        colorClasses(variant, intent),
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {leading}
      {children}
    </button>
  );
});
