import { useCallback, useEffect, useRef } from 'react';

/**
 * FLUX-1136: coalesces a burst of `artifactReady` notifications (an agent iterating on an
 * artifact publishes several revisions in quick succession) into a single reload of the final
 * revision, ~`delayMs` after the last one arrives — a debounced trailing edge, not a raw pass-
 * through. While `visible` is false the reload is deferred entirely rather than scheduled: the
 * target revision is remembered, and the moment `visible` flips back to true the latest pending
 * revision reloads immediately (no invisible background compiles, no lost revision either).
 *
 * Returns a stable `notify` function (identity never changes) — safe to use as an effect
 * dependency without re-subscribing the caller's event listener.
 */
export function useDebouncedArtifactReload(
  visible: boolean,
  onReload: (rev: number | undefined) => void,
  delayMs = 750,
): (rev: number | undefined) => void {
  const pendingRef = useRef<{ rev: number | undefined } | null>(null);
  const timerRef = useRef<number | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = useCallback(() => {
    clearTimer();
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    onReloadRef.current(pending.rev);
  }, []);

  const notify = useCallback(
    (rev: number | undefined) => {
      // A later event with no rev (defensive/legacy shape) shouldn't clobber an already-known
      // pending target — keep the last real rev we saw.
      const prevRev = pendingRef.current?.rev;
      pendingRef.current = { rev: rev ?? prevRev };
      if (!visibleRef.current) return; // hidden: remember the target, reload once on next show
      clearTimer();
      timerRef.current = window.setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );

  // Becoming visible again: apply whatever arrived while hidden right away — the user is
  // looking at it now, so there's no reason to debounce further.
  useEffect(() => {
    if (visible) flush();
  }, [visible, flush]);

  useEffect(() => clearTimer, []);

  return notify;
}
