import { useEffect, useRef, useState, type CSSProperties, type ElementType } from 'react';
import { useMotionTokens } from '../../motion/tokens';

const ROLL_DURATION_MS = 400;
const ROLL_STEPS = 12;
const ROLL_INTERVAL_MS = ROLL_DURATION_MS / ROLL_STEPS;
const POP_SCALE = 1.12;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

interface AnimatedCountProps {
  value: number;
  className?: string;
  style?: CSSProperties;
  /** Wrapper element — defaults to `span` so it drops into existing inline slots. */
  as?: ElementType;
}

/**
 * FLUX-1520: rolls a numeric readout through its intermediate integers over ~400ms instead of
 * snapping straight to the new value, with a subtle transform-only scale pop timed to the same
 * roll — one `setInterval` loop drives both the digit interpolation and the pop's decay so there
 * is a single cheap timer per instance (not rAF; a handful of steps, not per-frame). `tabular-nums`
 * keeps digit width stable mid-roll (no layout jitter on e.g. 9→10), and the pop is a CSS
 * `transform` only so the pill's box never resizes. Degrades to an instant snap under
 * `useMotionTokens().instant` (OS reduced-motion or `animationsEnabled=false`) — the same
 * contract every other portal animation follows; this component never calls `useReducedMotion()`
 * directly.
 */
export function AnimatedCount({ value, className = '', style, as: Component = 'span' }: AnimatedCountProps) {
  const { instant } = useMotionTokens();
  const [displayed, setDisplayed] = useState(value);
  const [scale, setScale] = useState(1);
  const displayedRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (instant) {
      setDisplayed(value);
      setScale(1);
      return;
    }
    const from = displayedRef.current;
    if (from === value) return;

    setScale(POP_SCALE);
    let step = 0;
    timerRef.current = setInterval(() => {
      step += 1;
      if (step >= ROLL_STEPS) {
        setDisplayed(value);
        setScale(1);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      const progress = easeOutCubic(step / ROLL_STEPS);
      setDisplayed(Math.round(from + (value - from) * progress));
      setScale(1 + (POP_SCALE - 1) * (1 - progress));
    }, ROLL_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // Only re-run when the target value or the instant flag changes — reading `displayed` via
    // the ref (not as a dependency) is what lets a mid-roll retarget resume from the current
    // on-screen value instead of restarting the effect on every intermediate step.
  }, [value, instant]);

  return (
    <Component
      className={`tabular-nums inline-block ${className}`.trim()}
      style={{
        ...style,
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transitionProperty: 'transform',
        transitionDuration: `${ROLL_INTERVAL_MS}ms`,
        transitionTimingFunction: 'ease-out',
      }}
    >
      {displayed}
    </Component>
  );
}
