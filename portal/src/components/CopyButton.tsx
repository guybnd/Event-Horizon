import { Check, Copy } from 'lucide-react';
import { useCopied } from '../hooks/useCopied';

/**
 * FLUX-683: a quiet icon button that copies `getText()` to the clipboard and briefly shows a
 * check. Styling is fully caller-owned via `className` (the assistant-turn affordance and the
 * code-fence affordance want different placement/colors), so this only owns the copy behavior,
 * the icon swap, and the accessible label. `getText` is a thunk so the (possibly large) source
 * is only materialized on click.
 */
export function CopyButton({
  getText,
  title = 'Copy',
  className = '',
}: {
  getText: () => string;
  title?: string;
  className?: string;
}) {
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copy(getText());
      }}
      title={copied ? 'Copied ✓' : title}
      aria-label={copied ? 'Copied' : title}
      className={className}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
