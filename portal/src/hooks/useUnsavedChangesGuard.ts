import { useEffect } from 'react';

/**
 * FLUX-979: warns via the browser's native "Leave site?" prompt when the tab is closed, refreshed,
 * or navigated away while `active` — the only guard that catches those paths (an in-app discard
 * confirmation only catches an in-app close attempt, e.g. the modal's X button or Escape).
 */
export function useUnsavedChangesGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}
