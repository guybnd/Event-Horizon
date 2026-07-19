import { useMemo } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { Transition } from 'framer-motion';
import { useAppSelector } from '../store/useAppSelector';

export type AnimationSpeed = 'fast' | 'normal' | 'slow';

/**
 * Base physics at animationSpeed:'normal' — settled live via the FLUX-1507 "Motion physics
 * tuner" artifact (stiffness/fade tuned by the user; press is the plan's untouched default).
 * Every new animation this ticket adds reads its timing from here instead of a local literal.
 */
const BASE_SPRING_STIFFNESS = 400;
const BASE_SPRING_DAMPING = 32;
const BASE_FADE_MS = 220;
const BASE_PRESS_MS = 90;

/** View-crossfade drift (piece 2) — tuned via the same artifact. */
export const CROSSFADE_DRIFT_PX = 8;
export const CROSSFADE_DIRECTION: 'up' | 'down' = 'down';

/** Cold-boot cascade (FLUX-1519) — column-to-column and card-to-card reveal stagger, played once
 *  on the first real board render. Reuses `CROSSFADE_DRIFT_PX` for the fade-up distance instead
 *  of a second drift literal. */
export const COLD_BOOT_STAGGER_MS = 70;

/** Duration multiplier per speed setting — the same fast/normal/slow ratios the three scattered
 *  `speedMap`s used (0.2s / 0.4s / 0.7s), preserved here as the single source of truth so
 *  switching to physics-based tokens doesn't change how the Settings toggle feels. */
const SPEED_SCALE: Record<AnimationSpeed, number> = { fast: 0.5, normal: 1, slow: 1.75 };

export interface MotionTokens {
  /** True when every new animation should degrade to a no-op — either the user has
   *  animationsEnabled=false, or prefers-reduced-motion is on at the OS level. */
  instant: boolean;
  /** Spatial spring — anything that moves position/size (card flight, card→modal morph). */
  spring: Transition;
  /** Approximate settle time (ms) of `spring` — for imperative timers (e.g. deferring heavy
   *  content mount until the open animation visually finishes) that can't read a spring's
   *  physics-derived duration directly. Derived from the damping ratio, which stays constant
   *  across `spring`'s speed scaling: settle ≈ 8 / damping seconds (mass = 1). */
  springSettleMs: number;
  /** Fade/color transition. */
  fade: Transition;
  /** Pressed/tap-state transition. */
  press: Transition;
  /** View-crossfade drift, already zeroed when `instant`. */
  crossfadeDriftPx: number;
  crossfadeDirection: 'up' | 'down';
}

const INSTANT: Transition = { duration: 0 };

/**
 * Centralized motion physics (FLUX-1507). Replaces the copy-pasted `speedMap` literals in
 * TaskModal/ChatDock/useTaskCardController and folds ChatDock's standalone `useReducedMotion()`
 * read into this one shared `instant` flag — no component should call `useReducedMotion()` on
 * its own anymore for a token-driven animation.
 */
export function useMotionTokens(): MotionTokens {
  const config = useAppSelector((s) => s.config);
  const reducedMotion = useReducedMotion();
  const animationsEnabled = config?.animationsEnabled ?? true;
  const speed = config?.animationSpeed || 'normal';
  const instant = !animationsEnabled || !!reducedMotion;

  return useMemo(() => {
    if (instant) {
      return {
        instant,
        spring: INSTANT,
        springSettleMs: 0,
        fade: INSTANT,
        press: INSTANT,
        crossfadeDriftPx: 0,
        crossfadeDirection: CROSSFADE_DIRECTION,
      };
    }
    // Scale stiffness/damping so the settle time shrinks/grows by `scale` while holding the
    // damping ratio constant (natural frequency ~ 1/scale ⇒ stiffness ~ 1/scale²; damping ~
    // sqrt(stiffness) ⇒ damping ~ 1/scale).
    const scale = SPEED_SCALE[speed];
    const damping = BASE_SPRING_DAMPING / scale;
    return {
      instant,
      spring: {
        type: 'spring' as const,
        stiffness: BASE_SPRING_STIFFNESS / (scale * scale),
        damping,
      },
      springSettleMs: (8 / damping) * 1000,
      fade: { duration: (BASE_FADE_MS / 1000) * scale, ease: 'easeOut' as const },
      press: { duration: (BASE_PRESS_MS / 1000) * scale, ease: 'easeOut' as const },
      crossfadeDriftPx: CROSSFADE_DRIFT_PX,
      crossfadeDirection: CROSSFADE_DIRECTION,
    };
  }, [instant, speed]);
}
