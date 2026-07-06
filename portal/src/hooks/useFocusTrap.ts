import { useEffect, useRef, type RefObject } from 'react';
import { useEscapeKey } from './useEscapeKey';

/**
 * FLUX-792: reusable focus trap for modal/dialog surfaces. Lifted from the proven inline
 * implementation in ConflictResolutionModal so dialogs stop leaking focus to the page behind
 * them (WCAG 2.4.3 / 2.1.2). On mount it records the previously-focused element and focuses the
 * first focusable inside `containerRef`; Tab/Shift+Tab cycle within the container; Escape calls
 * `onClose` (if given); on unmount focus is restored to where it was.
 *
 * Pass `active: false` to disable without changing hook order (e.g. while the dialog is closed).
 *
 * FLUX-1022: Escape is registered on the shared `useEscapeKey` LIFO stack (not this hook's own
 * listener) so a trapped modal participates in the same one-layer-per-press ordering as every
 * other overlay, instead of racing a second, competing `window` listener.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// FLUX-1118: containers of every currently-active (mounted, `active: true`) trap, so the Escape
// handler below can tell "focus drifted to plain page content" (no other trap involved — still
// close) apart from "focus is legitimately inside a DIFFERENT concurrently-mounted trap" (the
// real stacked-dialog cross-close case — withhold). Without this, a non-modal trap container
// (e.g. FloatingPanel, which has no backdrop blocking clicks to the rest of the page) would
// permanently lose "Escape closes me" the moment the user clicked elsewhere on the page.
const activeContainers = new Set<HTMLElement>();

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options?: { onClose?: (() => void) | undefined; active?: boolean },
): void {
  const active = options?.active ?? true;

  // Callers typically pass a fresh inline `onClose` arrow every render; reading it through a ref
  // (instead of listing it as a dep) keeps the effect from tearing down and re-running — and
  // stealing focus back to "first focusable" — on every parent re-render.
  const onCloseRef = useRef(options?.onClose);
  onCloseRef.current = options?.onClose;

  // FLUX-1022: fire onClose through the shared Escape stack. Scoped to this instance's container
  // (still checked at fire time) so that with multiple traps mounted at once (e.g. a dev-only
  // Studio screen alongside the main shell), only the one that currently has focus acts — the
  // registry's LIFO order already keeps this from double-firing every mounted trap.
  // FLUX-1118: "has focus" is relaxed from strict containment to "no OTHER active trap currently
  // owns focus" — a non-modal trap (no backdrop) can have focus click-dragged to plain page
  // content, and that shouldn't be confused with the real cross-close case where a different,
  // concurrently-mounted trap legitimately holds focus.
  useEscapeKey(
    () => {
      const el = containerRef.current;
      if (!el) return;
      if (el.contains(document.activeElement)) {
        onCloseRef.current?.();
        return;
      }
      const focusOwnedByAnotherTrap = Array.from(activeContainers).some(
        (other) => other !== el && other.contains(document.activeElement),
      );
      if (!focusOwnedByAnotherTrap) onCloseRef.current?.();
    },
    { enabled: active, ignoreWhenTyping: false },
  );

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previouslyFocused = (document.activeElement as HTMLElement | null);

    // FLUX-1118: register while mounted+active so the Escape handler above can discriminate
    // "focus left every trap" from "focus is inside a sibling trap".
    if (container) activeContainers.add(container);

    const focusables = () =>
      Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus into the dialog (first focusable, else the container itself).
    const first = focusables()[0];
    if (first) first.focus();
    else container?.focus?.();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !container) return;
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = els[0]!;
      const lastEl = els[els.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (container) activeContainers.delete(container);
      previouslyFocused?.focus?.();
    };
  }, [containerRef, active]);
}
