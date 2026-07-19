import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useMotionTokens } from '../motion/tokens';

interface KeepAliveViewProps {
  /** Whether this view is the one currently selected in the nav. */
  active: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Generalizes Board's inline keep-alive pattern (App.tsx, FLUX-983/1507) for other top-level
 * views: mount once on first activation and keep alive thereafter, toggling visibility with
 * CSS `display` instead of unmounting via AnimatePresence — so scroll position and local state
 * survive a switch away and back.
 *
 * The outer wrapper toggles `display` between `'contents'` and `'none'`, NOT `'block'`: the
 * child views render a `motion.div className="h-full min-h-0"` that must stay a *direct* child
 * of `<main className="flex-1 overflow-y-auto">` for its `h-full` to resolve against main's
 * flex-derived height (which is what keeps their own inner `flex-1 overflow-y-auto` scrollers
 * bounded). A `display:block` wrapper has auto height and would collapse that chain, pushing
 * scrolling up to `main`.
 */
export function KeepAliveView({ active, children, className }: KeepAliveViewProps) {
  const tokens = useMotionTokens();
  const [hasBeenActive, setHasBeenActive] = useState(() => active);
  useEffect(() => {
    if (active) setHasBeenActive(true);
  }, [active]);

  // Lags `active` by one fade duration on exit so the crossfade below has time to play before
  // the wrapper drops to `display:none` (mirrors `boardBoxHidden` in App.tsx).
  const [boxHidden, setBoxHidden] = useState(() => !active);
  useEffect(() => {
    if (active) { setBoxHidden(false); return; }
    const delayMs = tokens.instant ? 0 : (tokens.fade.duration ?? 0) * 1000 + 30;
    const t = setTimeout(() => setBoxHidden(true), delayMs);
    return () => clearTimeout(t);
  }, [active, tokens.instant, tokens.fade.duration]);

  const crossfadeVariants = useMemo(() => {
    const offset = tokens.crossfadeDirection === 'down' ? -tokens.crossfadeDriftPx : tokens.crossfadeDriftPx;
    return {
      initial: { opacity: 0, y: offset },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -offset },
    };
  }, [tokens.crossfadeDirection, tokens.crossfadeDriftPx]);

  if (!hasBeenActive) return null;

  return (
    <div style={{ display: (active || !boxHidden) ? 'contents' : 'none' }}>
      <motion.div
        className={className ?? 'h-full min-h-0'}
        variants={crossfadeVariants}
        initial="initial"
        animate={active ? 'animate' : 'exit'}
        transition={tokens.fade}
      >
        {children}
      </motion.div>
    </div>
  );
}
