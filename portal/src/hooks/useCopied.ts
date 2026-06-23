import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * FLUX-683: tiny clipboard hook with a transient "copied ✓" state. `copy(text)` writes to the
 * clipboard and flips `copied` true for `resetMs`, then reverts. Clipboard access requires a
 * secure context (`navigator.clipboard`), so it's optional-chained + try/catch — on failure it
 * no-ops quietly and returns false rather than throwing (degrades gracefully in an insecure
 * context / denied permission). The reset timer is cleared on unmount.
 *
 * Lives in its own module (not beside CopyButton) so the component file stays component-only and
 * Vite fast-refresh keeps working (react-refresh/only-export-components).
 */
export function useCopied(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), resetMs);
      return true;
    } catch {
      return false;
    }
  }, [resetMs]);

  return { copied, copy };
}
