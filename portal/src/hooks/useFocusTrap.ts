import { useEffect, type RefObject } from 'react';

/**
 * FLUX-792: reusable focus trap for modal/dialog surfaces. Lifted from the proven inline
 * implementation in ConflictResolutionModal so dialogs stop leaking focus to the page behind
 * them (WCAG 2.4.3 / 2.1.2). On mount it records the previously-focused element and focuses the
 * first focusable inside `containerRef`; Tab/Shift+Tab cycle within the container; Escape calls
 * `onClose` (if given); on unmount focus is restored to where it was.
 *
 * Pass `active: false` to disable without changing hook order (e.g. while the dialog is closed).
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options?: { onClose?: (() => void) | undefined; active?: boolean },
): void {
  const onClose = options?.onClose;
  const active = options?.active ?? true;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previouslyFocused = (document.activeElement as HTMLElement | null);

    const focusables = () =>
      Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus into the dialog (first focusable, else the container itself).
    const first = focusables()[0];
    if (first) first.focus();
    else container?.focus?.();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
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
      previouslyFocused?.focus?.();
    };
  }, [containerRef, onClose, active]);
}
