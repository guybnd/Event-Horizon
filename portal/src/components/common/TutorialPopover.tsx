import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { OnboardingMedia, prefersReducedMotion } from '../onboarding/OnboardingMedia';

/**
 * FLUX-762 — Generic, SHIPPING (no dev gate) in-board tutorial popover.
 *
 * Knows only {title, media, details, render-prop trigger} — nothing
 * onboarding-specific — so ANY board element can wrap its trigger and get a
 * bigger hover/focus panel (feature card, column header, icon button…). The
 * trigger is a RENDER-PROP (not a wrapper div) so the component injects
 * ref + handlers onto the caller's EXISTING element with zero box-model drift
 * (critical for the sm:grid-cols-2 feature grid).
 *
 * Positioning mirrors ContextMenu's Flyout algorithm (portal-to-body + fixed +
 * two-axis clamp that re-anchors on scroll/resize) — NOT CardCommentPopover's
 * static one-shot clamp — because the onboarding wizard scrolls and a static
 * clamp would detach the panel from its card. The hover lifecycle (200ms
 * close-grace cancelled by the panel's own onMouseEnter, openedByHover ref)
 * mirrors CardCommentPopover verbatim.
 *
 * A11y: tooltip/disclosure hybrid with NO focus trap. Opens on hover AND focus;
 * dismisses on Escape, blur (unless focus moved into the panel), and
 * mouseleave-with-grace. The media is rendered via the shared OnboardingMedia
 * (img-vs-video by extension, NEVER canvas) so GIFs animate and videos loop in the
 * panel exactly as in the thumbnail.
 *
 * Imports are limited to React, framer-motion, and the shared OnboardingMedia —
 * NOTHING from components/dev/** — so the Studio stays DCE'd out of prod.
 */

export interface TutorialMedia {
  src: string;
  alt?: string;
}

export interface TutorialTrigger {
  ref: React.Ref<HTMLElement>;
  'aria-describedby': string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (e: React.FocusEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface TutorialPopoverProps {
  title: string;
  /** image, gif, OR video — rendered via the shared OnboardingMedia, never canvas. */
  media?: TutorialMedia;
  /** extended copy (string or JSX). */
  details?: ReactNode;
  /** when true (or no media AND no details), the trigger is inert — no empty panel. */
  disabled?: boolean;
  placement?: 'top' | 'bottom' | 'auto';
  /** size override; default showcase ~w-[min(920px,94vw)]. */
  panelClassName?: string;
  /** default 'tooltip'; caller upgrades to 'dialog' only if details has interactive controls. */
  role?: 'tooltip' | 'dialog';
  /** hover-intent open debounce, default ~80ms. */
  openDelay?: number;
  /** close grace so cursor can travel into the panel, default 200ms (mirrors CardCommentPopover). */
  closeDelay?: number;
  children: (trigger: TutorialTrigger) => ReactNode;
}

type Placement = 'top' | 'bottom' | 'auto';

const GAP = 8;
const PAD = 8;

// FLUX-764: at most ONE TutorialPopover open at a time across the whole app, so
// sweeping between feature cards never leaves two panels overlapping. Each
// instance registers its close fn here on open and clears it on close/unmount.
let activeTutorialClose: (() => void) | null = null;

/**
 * Clamp math factored out so other surfaces can reuse one implementation. Mirrors
 * ContextMenu's Flyout: measure-before-paint in useLayoutEffect, two-axis clamp,
 * re-anchor on ResizeObserver(panel) + capture scroll + window resize. Returns a
 * fixed-position style; until coords are computed it parks the panel at
 * opacity:0 / left:-9999 (still measurable + focusable, unlike visibility:hidden).
 */
function useAnchoredPanel(
  triggerRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  placement: Placement,
): CSSProperties {
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return undefined;
    }
    const compute = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Vertical: 'auto'/'top' prefer ABOVE; flip BELOW when it would clip the top.
      // 'bottom' starts below. Then clamp into [pad, vh - height - pad].
      let top: number;
      if (placement === 'bottom') {
        top = trigger.bottom + GAP;
      } else {
        top = trigger.top - GAP - panel.height;
        if (top < PAD) top = trigger.bottom + GAP;
      }
      top = Math.max(PAD, Math.min(top, vh - panel.height - PAD));

      // Horizontal: center on the trigger, then clamp into [pad, vw - width - pad].
      let left = trigger.left + trigger.width / 2 - panel.width / 2;
      left = Math.max(PAD, Math.min(left, vw - panel.width - PAD));

      setCoords((prev) =>
        prev && prev.left === left && prev.top === top ? prev : { left, top },
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, placement, triggerRef, panelRef]);

  return {
    position: 'fixed',
    left: coords?.left ?? -9999,
    top: coords?.top ?? -9999,
    maxHeight: 'calc(100vh - 16px)',
    overflowY: 'auto',
    opacity: coords ? 1 : 0,
    pointerEvents: coords ? undefined : 'none',
    zIndex: 999999,
  };
}

export function TutorialPopover({
  title,
  media,
  details,
  disabled,
  placement = 'auto',
  panelClassName,
  role = 'tooltip',
  openDelay = 80,
  closeDelay = 200,
  children,
}: TutorialPopoverProps) {
  const panelId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openTimeout = useRef<number | null>(null);
  const closeTimeout = useRef<number | null>(null);
  const openedByHover = useRef(false);
  // Stable handle to THIS instance's close, for the global one-at-a-time
  // coordinator. Kept current just below, once doClose exists.
  const closeRef = useRef<() => void>(() => {});
  const [open, setOpen] = useState(false);

  // A trigger with neither media nor details (or an explicit disabled) must never
  // open an empty panel — it stays inert.
  const inert = !!disabled || (!media && details == null);

  const style = useAnchoredPanel(triggerRef, panelRef, open && !inert, placement);

  const clearOpenTimer = useCallback(() => {
    if (openTimeout.current !== null) {
      window.clearTimeout(openTimeout.current);
      openTimeout.current = null;
    }
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimeout.current !== null) {
      window.clearTimeout(closeTimeout.current);
      closeTimeout.current = null;
    }
  }, []);

  const doOpen = useCallback(
    (byHover: boolean) => {
      if (inert) return;
      clearCloseTimer();
      // Global one-at-a-time: close whichever OTHER popover is open first.
      if (activeTutorialClose && activeTutorialClose !== closeRef.current) {
        activeTutorialClose();
      }
      activeTutorialClose = closeRef.current;
      if (byHover) openedByHover.current = true;
      setOpen(true);
    },
    [inert, clearCloseTimer],
  );

  const doClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    openedByHover.current = false;
    if (activeTutorialClose === closeRef.current) activeTutorialClose = null;
    setOpen(false);
  }, [clearOpenTimer, clearCloseTimer]);

  // Keep the coordinator handle pointing at the latest close (cheap ref write).
  closeRef.current = doClose;

  // Hover-intent open: debounce so a quick pass-through doesn't flicker the panel.
  const scheduleHoverOpen = useCallback(() => {
    if (inert) return;
    clearCloseTimer();
    if (open) return;
    clearOpenTimer();
    openTimeout.current = window.setTimeout(() => {
      openTimeout.current = null;
      doOpen(true);
    }, openDelay);
  }, [inert, open, openDelay, clearCloseTimer, clearOpenTimer, doOpen]);

  // Close-grace: on mouseleave start a timer; the panel's own onMouseEnter cancels
  // it so the pointer can travel card→panel without closing (CardCommentPopover).
  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    if (closeTimeout.current !== null) return;
    closeTimeout.current = window.setTimeout(() => {
      closeTimeout.current = null;
      if (activeTutorialClose === closeRef.current) activeTutorialClose = null;
      setOpen(false);
      openedByHover.current = false;
    }, closeDelay);
  }, [closeDelay, clearOpenTimer]);

  // Escape-to-dismiss while open (also handled via the trigger onKeyDown the
  // render-prop supplies, mirroring ContextMenu's handleKey).
  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') doClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, doClose]);

  // Clean up every timer on unmount.
  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
      if (activeTutorialClose === closeRef.current) activeTutorialClose = null;
    },
    [clearOpenTimer, clearCloseTimer],
  );

  const trigger: TutorialTrigger = {
    ref: triggerRef,
    'aria-describedby': panelId,
    onMouseEnter: scheduleHoverOpen,
    onMouseLeave: () => {
      if (openedByHover.current) scheduleClose();
    },
    onFocus: () => doOpen(false),
    onBlur: (e: React.FocusEvent) => {
      // Ignore blur when focus moved into the panel itself.
      if (panelRef.current && e.relatedTarget && panelRef.current.contains(e.relatedTarget as Node)) {
        return;
      }
      doClose();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') doClose();
    },
  };

  const reduceMotion = prefersReducedMotion();

  return (
    <>
      {children(trigger)}
      {createPortal(
        <AnimatePresence>
          {open && !inert && (
            <motion.div
              ref={panelRef}
              id={panelId}
              role={role}
              aria-label={role === 'dialog' ? title : undefined}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.97 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.12 }}
              style={style}
              className={
                panelClassName ??
                'w-[min(920px,94vw)] max-w-[calc(100vw-16px)] rounded-2xl border border-gray-200/80 bg-white/95 p-5 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95'
              }
              onMouseEnter={clearCloseTimer}
              onMouseLeave={() => {
                if (openedByHover.current) scheduleClose();
              }}
              onFocusCapture={clearCloseTimer}
            >
              <div className="mb-2 text-base font-semibold text-gray-900 dark:text-white">
                {title}
              </div>
              {media && (
                <OnboardingMedia
                  image={media}
                  className="mb-4 max-h-[clamp(360px,64vh,680px)] w-full rounded-xl border border-gray-200 bg-gray-50 object-contain dark:border-white/10 dark:bg-white/[0.03]"
                />
              )}
              {details != null && (
                <div className="max-w-[70ch] text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                  {details}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
