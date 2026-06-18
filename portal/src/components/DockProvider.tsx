import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * FLUX-603: global ownership of the bottom chat dock's window/open state.
 *
 * The dock (taskbar + floating chat windows, FLUX-607) used to keep its open/acked/
 * dismissed/anchor state in `ChatDock`-local `useState` mounted inside `<Board>` — so it
 * couldn't be driven from a ticket card and was lost when you switched views. This provider
 * lifts that state to app root (`App.tsx`), adds `manuallyOpened` (ids opened from a card or
 * the modal that have no live CLI session yet), and exposes the actions a card needs.
 *
 * Two contexts on purpose: the ACTIONS are stable (functional setState + an `openRef`
 * mirror), so a ticket card consuming `useDockActions()` does NOT re-render every time a
 * dock window opens/closes. Only `ChatDock`, which needs the live lists, consumes the
 * full state via `useDock()`.
 */

export interface DockActions {
  /** Open a chat window for `id` and surface its card even with no active session.
   *  `from` (the clicked element) anchors where the window spawns. */
  openChat: (id: string, from?: HTMLElement | null) => void;
  /** Toggle a window open/closed (open path mirrors `openChat`). */
  toggle: (id: string, from?: HTMLElement | null) => void;
  /** Retire a card into History (drops its window + manual-open flag). */
  closeCard: (id: string) => void;
  /** Reopen a chat from the History popover (same as `openChat`). */
  reopenFromHistory: (id: string, from?: HTMLElement | null) => void;
}

export interface DockState {
  open: string[];
  acked: string[];
  dismissed: string[];
  /** Ids opened from a card/modal that may have no live session — surfaced as cards anyway. */
  manuallyOpened: string[];
  /** Per-chat x-center of the element that triggered the open, so a window spawns "out of" it. */
  anchors: Record<string, number>;
}

const DockActionsContext = createContext<DockActions | null>(null);
const DockStateContext = createContext<DockState | null>(null);

export function DockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string[]>([]);
  const [acked, setAcked] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]); // most-recent-first
  const [manuallyOpened, setManuallyOpened] = useState<string[]>([]);
  const [anchors, setAnchors] = useState<Record<string, number>>({});

  // Mirror of `open` so the stable `toggle` action can read the current value without a
  // dependency (which would make the action identity churn and re-render every card).
  const openRef = useRef<string[]>(open);
  openRef.current = open;

  const actions = useMemo<DockActions>(() => {
    const recordAnchor = (id: string, el?: HTMLElement | null) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchors((prev) => ({ ...prev, [id]: r.left + r.width / 2 }));
    };

    const openWindow = (id: string, from?: HTMLElement | null) => {
      recordAnchor(id, from);
      setOpen((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setAcked((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setDismissed((prev) => prev.filter((x) => x !== id));
    };

    const openChat = (id: string, from?: HTMLElement | null) => {
      setManuallyOpened((prev) => (prev.includes(id) ? prev : [...prev, id]));
      openWindow(id, from);
    };

    return {
      openChat,
      reopenFromHistory: openChat,
      toggle: (id, from) => {
        if (openRef.current.includes(id)) {
          setOpen((prev) => prev.filter((x) => x !== id));
          return;
        }
        openWindow(id, from);
      },
      closeCard: (id) => {
        setDismissed((prev) => [id, ...prev.filter((x) => x !== id)]);
        setOpen((prev) => prev.filter((x) => x !== id));
        setAcked((prev) => prev.filter((x) => x !== id));
        setManuallyOpened((prev) => prev.filter((x) => x !== id));
      },
    };
  }, []);

  const state = useMemo<DockState>(
    () => ({ open, acked, dismissed, manuallyOpened, anchors }),
    [open, acked, dismissed, manuallyOpened, anchors],
  );

  return (
    <DockActionsContext.Provider value={actions}>
      <DockStateContext.Provider value={state}>{children}</DockStateContext.Provider>
    </DockActionsContext.Provider>
  );
}

/** Stable dock actions — safe for cards to consume without extra re-renders. */
// eslint-disable-next-line react-refresh/only-export-components -- canonical context hook, idiomatically colocated with its provider.
export function useDockActions(): DockActions {
  const ctx = useContext(DockActionsContext);
  if (!ctx) throw new Error('useDockActions must be used within a DockProvider');
  return ctx;
}

/** Full dock state + actions — for the dock itself. */
// eslint-disable-next-line react-refresh/only-export-components -- canonical context hook, idiomatically colocated with its provider.
export function useDock(): DockState & DockActions {
  const state = useContext(DockStateContext);
  const actions = useContext(DockActionsContext);
  if (!state || !actions) throw new Error('useDock must be used within a DockProvider');
  return { ...state, ...actions };
}
