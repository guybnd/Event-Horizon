import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGhStatus, recheckGh, type GhRecheckResult } from '../api';

export interface UseGhStatusResult {
  gh: GhRecheckResult | null;
  checking: boolean;
  /** True once a probe (initial, transition-triggered, or recheck) has settled — resolved or
   * rejected — for the current `enabled` session. False while a probe is in flight or hasn't
   * started yet, so consumers can tell "no answer yet" apart from "checked, found nothing". */
  settled: boolean;
  error: string | null;
  recheck: () => void;
}

/**
 * FLUX-1686: one gh-availability probe, shared by both launch dialogs (`OrchestrationLauncher`,
 * `StartTaskPrompt`). `enabled` is required, not a convenience — mount time is NOT dialog-open
 * time at every call site (`OrchestrationLauncher` stays mounted for the whole ticket-modal
 * lifetime, rendering `null` while closed), so a plain fetch-on-mount would probe once at first
 * mount and then show an increasingly stale answer on every later open. Keying the effect on
 * `enabled` instead makes each `false -> true` transition a fresh probe, and resets `gh`/`error`
 * to `null` on the way down so a closed dialog never shows a stale answer on next open.
 */
export function useGhStatus(enabled: boolean): UseGhStatusResult {
  const [gh, setGh] = useState<GhRecheckResult | null>(null);
  const [checking, setChecking] = useState(enabled);
  const [settled, setSettled] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Reset (not just clear) on mount: under StrictMode's dev-only double-invoke
  // (setup -> cleanup -> setup), a one-shot `useRef(true)` never recovers from the
  // first cleanup, permanently wedging `recheck()`'s post-await guards to false.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // FLUX-1693: `useState(enabled)` above only seeds `checking`/`settled` correctly at *mount*.
  // On a later `false -> true` transition of an already-mounted hook (OrchestrationLauncher
  // stays mounted for the whole modal lifetime), an effect-based update would leave one commit
  // where `enabled` has flipped true but `checking`/`settled` still reflect the old (disabled)
  // values, because passive effects run after that render commits — the exact gap BranchSection
  // renders its "unknown" panel into. Adjusting state here, during render, instead of in the
  // effect below, makes React redo this render with the corrected values before anything commits.
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    if (enabled) {
      setChecking(true);
      setSettled(false);
    } else {
      setGh(null);
      setChecking(false);
      setSettled(true);
      setError(null);
    }
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(null);
    fetchGhStatus()
      .then((result) => {
        if (cancelled) return;
        setGh(result);
        setChecking(false);
        setSettled(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // FLUX-1687's onboarding-wizard bug, inverted: a failed probe must clear `gh` to null
        // as it sets `error`, so the consumer renders "unknown" instead of a confident stale
        // answer from a previous successful open.
        setGh(null);
        setError(err instanceof Error ? err.message : 'Failed to fetch GitHub CLI status');
        setChecking(false);
        setSettled(true);
      });
    return () => { cancelled = true; };
  }, [enabled]);

  const recheck = useCallback(() => {
    setChecking(true);
    setSettled(false);
    setError(null);
    recheckGh()
      .then((result) => {
        if (!mountedRef.current) return;
        setGh(result);
        setChecking(false);
        setSettled(true);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setGh(null);
        setError(err instanceof Error ? err.message : 'Failed to recheck GitHub CLI');
        setChecking(false);
        setSettled(true);
      });
  }, []);

  return { gh, checking, settled, error, recheck };
}
