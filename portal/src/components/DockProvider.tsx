import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** localStorage key for the dismissed-card set (matches the `eh-`-prefixed convention). */
const DISMISSED_KEY = 'eh-dock-dismissed';

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
  /** FLUX-623: persist a conversation's unsent composer text so minimizing (which unmounts
   *  the window) no longer discards it. Keyed per conversation id. */
  setDraft: (id: string, text: string) => void;
}

export interface DockState {
  open: string[];
  acked: string[];
  dismissed: string[];
  /** Ids opened from a card/modal that may have no live session — surfaced as cards anyway. */
  manuallyOpened: string[];
  /** Per-chat x-center of the element that triggered the open, so a window spawns "out of" it. */
  anchors: Record<string, number>;
  /** FLUX-623: per-conversation unsent composer text. In-memory (resets on full reload, like
   *  `seenRef` baselines in ChatDock); survives minimize/reopen + view switches because the dock
   *  state is app-root-scoped. Pruned in `closeCard` when a chat is retired to History. */
  drafts: Record<string, string>;
}

const DockActionsContext = createContext<DockActions | null>(null);
const DockStateContext = createContext<DockState | null>(null);

export function DockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string[]>([]);
  const [acked, setAcked] = useState<string[]>([]);
  // FLUX-635: rehydrate dismissed cards from localStorage so closing a card survives a reload.
  const [dismissed, setDismissed] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }); // most-recent-first
  const [manuallyOpened, setManuallyOpened] = useState<string[]>([]);
  const [anchors, setAnchors] = useState<Record<string, number>>({});
  // FLUX-623: per-conversation unsent composer text, so minimizing a chat (which unmounts its
  // window subtree) no longer discards what the user typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // FLUX-635: persist dismissals on change. Cap to bound growth (History only shows HISTORY_CAP).
  useEffect(() => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed.slice(0, 50)));
    } catch {
      /* quota exceeded / private mode — dismissal just won't persist this load */
    }
  }, [dismissed]);

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
        // FLUX-623: retiring a chat to History clears its draft — reopening starts empty.
        setDrafts((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      },
      // FLUX-623: prune empty drafts so an emptied composer doesn't linger in the map.
      setDraft: (id, text) =>
        setDrafts((prev) => {
          if (text) return prev[id] === text ? prev : { ...prev, [id]: text };
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        }),
    };
  }, []);

  const state = useMemo<DockState>(
    () => ({ open, acked, dismissed, manuallyOpened, anchors, drafts }),
    [open, acked, dismissed, manuallyOpened, anchors, drafts],
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
