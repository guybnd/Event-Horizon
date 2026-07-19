import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useMotionTokens } from './tokens';

export interface SuccessMarkProps {
  /** Diameter in px. Default 28. */
  size?: number;
  /** Stroke/fill color. Default the shared success token. */
  tone?: string;
  className?: string;
  /** Fires once the gesture finishes (immediately when `instant`). */
  onDone?: () => void;
}

/**
 * FLUX-1526: the one restrained "confirm" gesture — an SVG check that draws itself, then the
 * host settles with a tiny scale bounce. Reads all timing from `useMotionTokens()` (no local
 * literal durations) so it degrades to the final checked state with zero animation under
 * reduced-motion / animationsEnabled=false, same as every other FLUX-1507 token-driven motion.
 * Self-contained and one-shot: mount it on a success event and it un-renders itself after the
 * gesture completes — callers don't need to manage their own unmount timer.
 */
export function SuccessMark({ size = 28, tone = 'rgb(var(--eh-state-success-rgb))', className, onDone }: SuccessMarkProps) {
  const tokens = useMotionTokens();
  // Draw ≈ 2x the shared fade duration — matches the plan's ~440ms feel at normal speed while
  // staying proportional to the user's animationSpeed setting instead of a fixed literal.
  const drawMs = tokens.instant ? 0 : (tokens.fade.duration ?? 0.22) * 1000 * 2;
  const settleMs = tokens.instant ? 0 : tokens.springSettleMs;
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => { setDone(true); onDone?.(); }, drawMs + settleMs);
    return () => window.clearTimeout(t);
    // Intentionally mount-only: this is a one-shot gesture, its duration shouldn't restart if
    // tokens change mid-flight (e.g. a settings save while it's playing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (done) return null;

  return (
    <motion.div
      className={className}
      style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      initial={tokens.instant ? false : { scale: 0.7, opacity: 0 }}
      animate={{ scale: [0.7, 1.04, 1], opacity: 1 }}
      transition={tokens.instant ? { duration: 0 } : { duration: (drawMs + settleMs) / 1000, times: [0, 0.6, 1], ease: 'easeOut' }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="11" fill={tone} opacity={0.15} />
        <motion.path
          d="M7 12.4l3.3 3.3L17.3 8.4"
          stroke={tone}
          strokeWidth={2.3}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={tokens.instant ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={tokens.instant ? { duration: 0 } : { duration: drawMs / 1000, ease: 'easeOut' }}
        />
      </svg>
    </motion.div>
  );
}
