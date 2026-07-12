import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BOARD_CONVERSATION_ID } from '../api';

/** localStorage key for the dismissed-card set (matches the `eh-`-prefixed convention). */
const DISMISSED_KEY = 'eh-dock-dismissed';
/** FLUX-727: localStorage key for the manual tab order (left→right). */
const ORDER_KEY = 'eh-dock-order';
/** FLUX-728: cap on the manual tab order — applied to both the in-memory state and the localStorage
 *  write so inactive remembered ids can't accumulate unboundedly. */
const ORDER_CAP = 50;
/** FLUX-1252: localStorage key for the manually-opened tab set (ids surfaced as a tab even with no
 *  active/recent CLI session, e.g. a freshly-created Scratch Chat). Without this, a full reload reset
 *  the in-memory set to `[]`, dropping the tab of any chat with no "surfaced" session status. */
const MANUALLY_OPENED_KEY = 'eh-dock-manually-opened';
/** FLUX-1252: cap on the manually-opened set, mirroring `ORDER_CAP`. */
const MANUALLY_OPENED_CAP = 50;
/** FLUX-734: localStorage key for the per-chat ticket-sideview open set. */
const SIDEVIEW_KEY = 'eh-dock-sideview';
/** FLUX-740: localStorage key for the (global) sideview panel width, set by the chat↔panel divider. */
const SIDEVIEW_WIDTH_KEY = 'eh-dock-sideview-width';
/** FLUX-744: localStorage key for "the user has explicitly set the sideview width via the divider".
 *  Until this is true, opening the sideview seeds a proportional (~45%) default from the chat width. */
const SIDEVIEW_WIDTH_USERSET_KEY = 'eh-dock-sideview-width-userset';
/** FLUX-740: localStorage key for the per-section sideview open/collapsed map (by section id). */
const SECTION_OPEN_KEY = 'eh-dock-section-open';
/** FLUX-920: localStorage key for the per-conversation chat-window geometry (size + dragged position). */
const WINDOW_GEOM_KEY = 'eh-dock-window-geom';
/** FLUX-920: cap on the geometry map — applied to the localStorage write so stored ids for chats that
 *  were never retired (so never pruned by `closeCard`) can't accumulate unboundedly. Mirrors ORDER_CAP. */
const WINDOW_GEOM_CAP = 50;

/** FLUX-740: default sideview width + the clamp the divider enforces. Mirrored in ChatDock's drag. */
export const DEFAULT_SIDEVIEW_WIDTH = 380;
export const MIN_SIDEVIEW_WIDTH = 280;
/** FLUX-744: raised from 680 so the proportional ~45% open width (seeded from a wide chat column) is
 *  not clipped on large windows; the on-screen clamp in ChatDock keeps the whole window in view. */
export const MAX_SIDEVIEW_WIDTH = 1000;
/** FLUX-744: chat:ticket split used to seed the sideview width on open — ticket ≈ 45% of the window,
 *  chat ≈ 55%, so ticket = chat * (45/55). */
export const SIDEVIEW_OPEN_RATIO = 45 / 55;

/** Rehydrate a persisted string[] from localStorage, tolerating missing/corrupt values. */
function readStringArray(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** FLUX-740: rehydrate a persisted number, clamped to [min, max], falling back on missing/corrupt. */
function readNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  } catch {
    return fallback;
  }
}

/** FLUX-744: rehydrate a persisted boolean flag, falling back on missing/corrupt values. */
function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

/** FLUX-740: rehydrate a persisted Record<string, boolean>, tolerating missing/corrupt values. */
function readBoolRecord(key: string): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** FLUX-920: rehydrate the per-conversation window-geometry map, dropping malformed entries (a valid
 *  entry has finite `w`/`h`; `left`/`bottom` are optional and only kept when finite). */
function readGeomRecord(key: string): Record<string, WindowGeometry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, WindowGeometry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;
      const g = v as Record<string, unknown>;
      const w = Number(g.w);
      const h = Number(g.h);
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      const entry: WindowGeometry = { w, h };
      if (Number.isFinite(Number(g.left))) entry.left = Number(g.left);
      if (Number.isFinite(Number(g.bottom))) entry.bottom = Number(g.bottom);
      out[k] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

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

/** FLUX-666: a conversation's persisted composer chip selections (model / effort / permission).
 *  Each is the chip's `value` ('' = the chip's "Default" option); an all-empty object is pruned
 *  from the `selections` map, mirroring how an empty text draft is pruned from `drafts`. */
export interface ComposerSelections {
  model?: string;
  effort?: string;
  permission?: string;
}

/** FLUX-920: a chat window's persisted footprint. `w`/`h` are the resizable chat-column size; the
 *  optional `left`/`bottom` are the dragged bottom-pinned position (absent until the window is dragged,
 *  so a resize-only window persists size without forcing a position). Persisted to localStorage so the
 *  footprint survives both minimize/reopen (window subtree unmount) and a full reload. */
export interface WindowGeometry {
  w: number;
  h: number;
  left?: number;
  bottom?: number;
}

/** FLUX-801: the on-screen rect of the element that triggered an open, captured at click time.
 *  Threaded to ChatDock so a window's open/close animation can grow out of (and shrink back to)
 *  the clicked card. A plain `{left,top,width,height}` snapshot, not a live DOMRect. */
export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockActions {
  /** Open a chat window for `id` and surface its card even with no active session.
   *  `from` (the clicked element) anchors where the window spawns. */
  openChat: (id: string, from?: HTMLElement | null) => void;
  /** FLUX-801: bring an already-open window to the front of the paint order (the dock renders
   *  `open` in array order, so "front" = last). No-op if absent or already frontmost. Called on
   *  open/re-click and on a window mousedown so the active chat paints above its siblings. */
  raise: (id: string) => void;
  /** FLUX-744: open a ticket's chat window AND ensure its sideview (ticket panel) is open. This is the
   *  default "open this ticket" action — board/deck cards and global search route here, so opening a
   *  ticket lands in the chat-aligned view with the ticket panel showing instead of the center modal. */
  openTicket: (id: string, from?: HTMLElement | null) => void;
  /** FLUX-810: open the orchestrator (`__board__`) chat window. Unlike `openTicket` this does NOT
   *  force the ticket sideview (the board has no ticket panel, FLUX-734); it only opens the chat,
   *  never toggles it closed. Used by the "Orchestrator replied" notification card-click. */
  openBoard: (from?: HTMLElement | null) => void;
  /** Toggle a window open/closed (open path mirrors `openChat`). */
  toggle: (id: string, from?: HTMLElement | null) => void;
  /** Retire a card into History (drops its window + manual-open flag). */
  closeCard: (id: string) => void;
  /** Reopen a chat from the History popover (same as `openChat`). */
  reopenFromHistory: (id: string, from?: HTMLElement | null) => void;
  /** FLUX-623: persist a conversation's unsent composer text so minimizing (which unmounts
   *  the window) no longer discards it. Keyed per conversation id. */
  setDraft: (id: string, text: string) => void;
  /** FLUX-666: persist a conversation's composer model/effort/permission chip selections so
   *  minimizing (which unmounts the window) no longer resets them. Keyed per conversation id;
   *  mirrors `setDraft` — an all-default selection is pruned from the map. */
  setSelections: (id: string, selections: ComposerSelections) => void;
  /** FLUX-727: commit a new left→right tab order after a drag. The dragged arrangement becomes
   *  the front of the persisted order; any ids it omits (e.g. inactive-but-remembered) are kept,
   *  appended after, so a drag is never lossy. */
  reorder: (ids: string[]) => void;
  /** FLUX-727: move a tab to the LEFT (front of the order). Fired on the two promote-left events
   *  (a new chat appears, or a chat raises a prompt / enters needs-input). No-op when already front
   *  so the promotion effect can call it idempotently without churning state. */
  promoteToFront: (id: string) => void;
  /** FLUX-734: toggle the ticket sideview panel for a chat window open/closed. */
  toggleSideView: (id: string) => void;
  /** FLUX-887: idempotently OPEN the ticket sideview panel (no-op if already open) — used by the
   *  inline artifact card's "Open in panel" action, which must reveal the panel without the risk of
   *  `toggleSideView` closing an already-open one. */
  openSideView: (id: string) => void;
  /** FLUX-740: set the (global) sideview panel width — driven by the chat↔panel resize divider.
   *  Clamped to [MIN_SIDEVIEW_WIDTH, MAX_SIDEVIEW_WIDTH] and persisted so it survives reloads.
   *  FLUX-744: this is the user's *explicit* choice, so it also marks the width "user-set" — after
   *  this, opening the sideview keeps the user's width instead of re-seeding the proportional default. */
  setSideviewWidth: (width: number) => void;
  /** FLUX-744: seed a proportional (~45% of the window) sideview width from the live chat-column
   *  width at open time. `maxWidth` (optional) is an upper bound so the grown window still fits the
   *  viewport — passed by the caller that knows the viewport. No-op once the user has dragged the
   *  divider (see `setSideviewWidth`), so an explicit width always wins on later opens. */
  seedSideviewWidth: (chatWidth: number, maxWidth?: number) => void;
  /** FLUX-740: persist a sideview section's open/collapsed state, keyed by section id, so a user's
   *  collapse choices survive remount / reload. */
  setSectionOpen: (sectionId: string, open: boolean) => void;
  /** FLUX-920: persist a chat window's footprint, keyed per conversation id, so a manual resize/drag
   *  survives minimize/reopen (which unmounts the window) and a full reload. Merge-patched: a size-only
   *  update (`{w,h}`) keeps any stored position and vice-versa. Pruned in `closeCard`. */
  setWindowGeometry: (id: string, geom: Partial<WindowGeometry>) => void;
  /** FLUX-1273: open the full-screen plan-approval panel for a ticket (AttentionDock's 📋 item, the
   *  in-chat plan-approval card, and the ticket sideview's persistent "View Plan" affordance all route
   *  here) — mounted inside that ticket's chat window scope so it can post straight into the live
   *  conversation via the same `chat.send`/`chat.enqueue` the artifact annotator already uses. */
  openPlanApproval: (id: string) => void;
  /** FLUX-1273: close the plan-approval panel. */
  closePlanApproval: () => void;
}

export interface DockState {
  open: string[];
  acked: string[];
  dismissed: string[];
  /** Ids opened from a card/modal that may have no live session — surfaced as cards anyway.
   *  FLUX-1252: persisted, so a Scratch Chat (whose only surface is this tab) survives a reload. */
  manuallyOpened: string[];
  /** Per-chat x-center of the element that triggered the open, so a window spawns "out of" it. */
  anchors: Record<string, number>;
  /** FLUX-801: per-chat full source rect captured at click time, so the window's open/close
   *  animation can grow from / shrink to the clicked card. Parallel to `anchors` (which keeps the
   *  x-center contract intact for spawn positioning). */
  anchorRects: Record<string, AnchorRect>;
  /** FLUX-727: persisted manual tab order (left→right). The dock renders this filtered to active
   *  tickets (appending any active id not yet here), so a drag order sticks and survives reloads. */
  order: string[];
  /** FLUX-734: chat ids whose ticket sideview panel is expanded. Persisted so opening the ticket
   *  alongside its chat sticks across reloads / view switches. */
  sideviewOpen: string[];
  /** FLUX-740: the (global) ticket-sideview panel width in px, set by the chat↔panel divider.
   *  Persisted alongside `sideviewOpen` so a rebalanced layout survives reloads. */
  sideviewWidth: number;
  /** FLUX-744: whether the user has explicitly set `sideviewWidth` via the divider. While false, the
   *  sideview opens at a proportional (~45%) default seeded from the chat width; once true, the user's
   *  width is honored on every later open. Persisted. */
  sideviewWidthUserSet: boolean;
  /** FLUX-740: per-section open/collapsed state for the sideview, keyed by section id. A section
   *  with no entry uses its registry default; an entry is the user's explicit override. Persisted. */
  sectionOpen: Record<string, boolean>;
  /** FLUX-623: per-conversation unsent composer text. In-memory (resets on full reload, like
   *  `seenRef` baselines in ChatDock); survives minimize/reopen + view switches because the dock
   *  state is app-root-scoped. Pruned in `closeCard` when a chat is retired to History. */
  drafts: Record<string, string>;
  /** FLUX-666: per-conversation composer chip selections (model/effort/permission). Same lifecycle
   *  as `drafts` — in-memory, survives minimize/reopen, pruned on `closeCard` and on send. */
  selections: Record<string, ComposerSelections>;
  /** FLUX-920: per-conversation chat-window geometry (size + dragged position). Unlike `drafts`/
   *  `selections` this is localStorage-persisted, so a resized/moved window also survives a full reload.
   *  Pruned in `closeCard` when a chat is retired to History. */
  windowGeometry: Record<string, WindowGeometry>;
  /** FLUX-1273: the ticket id whose full-screen plan-approval panel is open, or null. In-memory only
   *  (like `anchors`) — an open panel doesn't need to survive a reload. */
  planApprovalOpen: string | null;
  /** FLUX-1381: bumped on EVERY `openPlanApproval` call, including a repeat open of the id already
   *  held. `planApprovalOpen` alone can't distinguish "already open" from "re-requested while
   *  minimized" — the same-id `setPlanApprovalOpen` bails out (no re-render), so ChatDock's
   *  minimize-reset effect never re-fired and every "open plan" entry point went dead on a minimized
   *  panel. Pairing the id with this counter makes repeat opens observable. */
  planApprovalNonce: number;
}

const DockActionsContext = createContext<DockActions | null>(null);
const DockStateContext = createContext<DockState | null>(null);
/** FLUX-923: just the open-window id list, in its own context so consumers that only care WHICH chats
 *  are open (e.g. the AttentionDock's open=inline/minimized=dock attention handoff) re-render when a
 *  window opens/closes/minimizes — NOT on every composer keystroke (drafts live in the broad DockState). */
const DockOpenContext = createContext<string[]>([]);

export function DockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string[]>([]);
  const [acked, setAcked] = useState<string[]>([]);
  // FLUX-635: rehydrate dismissed cards from localStorage so closing a card survives a reload.
  const [dismissed, setDismissed] = useState<string[]>(() => readStringArray(DISMISSED_KEY)); // most-recent-first
  // FLUX-727: rehydrate the manual tab order so a drag-imposed arrangement survives a reload.
  const [order, setOrder] = useState<string[]>(() => readStringArray(ORDER_KEY)); // left→right
  // FLUX-734: rehydrate the per-chat sideview open set so an expanded ticket panel survives a reload.
  const [sideviewOpen, setSideviewOpen] = useState<string[]>(() => readStringArray(SIDEVIEW_KEY));
  // FLUX-740: rehydrate the divider-set sideview width + per-section collapse choices.
  const [sideviewWidth, setSideviewWidthState] = useState<number>(
    () => readNumber(SIDEVIEW_WIDTH_KEY, DEFAULT_SIDEVIEW_WIDTH, MIN_SIDEVIEW_WIDTH, MAX_SIDEVIEW_WIDTH),
  );
  // FLUX-744: rehydrate whether the user has explicitly set the width (divider drag); gates the
  // proportional open-seed below.
  const [sideviewWidthUserSet, setSideviewWidthUserSet] = useState<boolean>(
    () => readBool(SIDEVIEW_WIDTH_USERSET_KEY, false),
  );
  const [sectionOpen, setSectionOpenState] = useState<Record<string, boolean>>(() => readBoolRecord(SECTION_OPEN_KEY));
  // FLUX-1252: rehydrate the manually-opened tab set so a Scratch Chat (or any manually-opened chat
  // with no SURFACE_STATUSES-qualifying session) doesn't lose its only tab-bar surface on reload.
  const [manuallyOpened, setManuallyOpened] = useState<string[]>(() => readStringArray(MANUALLY_OPENED_KEY));
  const [anchors, setAnchors] = useState<Record<string, number>>({});
  // FLUX-801: full source rects (parallel to `anchors`) for the pop-open/close animation.
  const [anchorRects, setAnchorRects] = useState<Record<string, AnchorRect>>({});
  // FLUX-623: per-conversation unsent composer text, so minimizing a chat (which unmounts its
  // window subtree) no longer discards what the user typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // FLUX-666: per-conversation composer chip selections (model/effort/permission), so minimizing
  // (which unmounts the window subtree) no longer resets them. Mirrors `drafts`.
  const [selections, setSelections] = useState<Record<string, ComposerSelections>>({});
  // FLUX-920: per-conversation chat-window geometry, rehydrated from localStorage so a resized/dragged
  // window survives both minimize/reopen AND a full reload (unlike the in-memory drafts/selections).
  const [windowGeometry, setWindowGeometryState] = useState<Record<string, WindowGeometry>>(
    () => readGeomRecord(WINDOW_GEOM_KEY),
  );
  // FLUX-1273: the ticket id whose full-screen plan-approval panel is open (null = none).
  const [planApprovalOpen, setPlanApprovalOpen] = useState<string | null>(null);
  // FLUX-1381: repeat-open counter paired with the id (see the DockState field doc).
  const [planApprovalNonce, setPlanApprovalNonce] = useState(0);

  // FLUX-635: persist dismissals on change. Cap to bound growth (History only shows HISTORY_CAP).
  useEffect(() => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed.slice(0, 50)));
    } catch {
      /* quota exceeded / private mode — dismissal just won't persist this load */
    }
  }, [dismissed]);

  // FLUX-727: persist the manual tab order on change. Capped like `dismissed` to bound growth.
  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order.slice(0, ORDER_CAP)));
    } catch {
      /* quota exceeded / private mode — order just won't persist this load */
    }
  }, [order]);

  // FLUX-1252: persist the manually-opened tab set on change. Capped like `order` to bound growth.
  useEffect(() => {
    try {
      localStorage.setItem(MANUALLY_OPENED_KEY, JSON.stringify(manuallyOpened.slice(0, MANUALLY_OPENED_CAP)));
    } catch {
      /* quota exceeded / private mode — manually-opened set just won't persist this load */
    }
  }, [manuallyOpened]);

  // FLUX-734: persist the sideview open set on change.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEVIEW_KEY, JSON.stringify(sideviewOpen.slice(0, 50)));
    } catch {
      /* quota exceeded / private mode — sideview state just won't persist this load */
    }
  }, [sideviewOpen]);

  // FLUX-740: persist the divider-set sideview width.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEVIEW_WIDTH_KEY, String(sideviewWidth));
    } catch {
      /* quota exceeded / private mode — width just won't persist this load */
    }
  }, [sideviewWidth]);

  // FLUX-744: persist the "user explicitly set the width" flag.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEVIEW_WIDTH_USERSET_KEY, String(sideviewWidthUserSet));
    } catch {
      /* quota exceeded / private mode — flag just won't persist this load */
    }
  }, [sideviewWidthUserSet]);

  // FLUX-740: persist per-section collapse choices.
  useEffect(() => {
    try {
      localStorage.setItem(SECTION_OPEN_KEY, JSON.stringify(sectionOpen));
    } catch {
      /* quota exceeded / private mode — section state just won't persist this load */
    }
  }, [sectionOpen]);

  // FLUX-920: persist the per-conversation window geometry. Capped (like the order map) so ids for
  // chats never retired through `closeCard` can't grow the stored map unboundedly.
  useEffect(() => {
    try {
      const entries = Object.entries(windowGeometry).slice(0, WINDOW_GEOM_CAP);
      localStorage.setItem(WINDOW_GEOM_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* quota exceeded / private mode — geometry just won't persist this load */
    }
  }, [windowGeometry]);

  // Mirror of `open` so the stable `toggle` action can read the current value without a
  // dependency (which would make the action identity churn and re-render every card).
  const openRef = useRef<string[]>(open);
  openRef.current = open;
  // FLUX-744: mirror of the user-set flag so the stable `seedSideviewWidth` action can read the
  // current value without becoming a dependency (which would churn every consumer's identity).
  const widthUserSetRef = useRef<boolean>(sideviewWidthUserSet);
  widthUserSetRef.current = sideviewWidthUserSet;

  const actions = useMemo<DockActions>(() => {
    const recordAnchor = (id: string, el?: HTMLElement | null) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchors((prev) => ({ ...prev, [id]: r.left + r.width / 2 }));
      // FLUX-801: keep the full rect too, so the window can animate out of the clicked card.
      setAnchorRects((prev) => ({ ...prev, [id]: { left: r.left, top: r.top, width: r.width, height: r.height } }));
    };

    const openWindow = (id: string, from?: HTMLElement | null) => {
      recordAnchor(id, from);
      // FLUX-801: opening (or re-clicking) a card brings its window to the front of the paint order
      // (last in `open`), so the freshly opened chat draws above any already-open siblings.
      setOpen((prev) => (prev.includes(id) ? [...prev.filter((x) => x !== id), id] : [...prev, id]));
      setAcked((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setDismissed((prev) => prev.filter((x) => x !== id));
    };

    const openChat = (id: string, from?: HTMLElement | null) => {
      setManuallyOpened((prev) => (prev.includes(id) ? prev : [...prev, id]));
      openWindow(id, from);
    };

    return {
      openChat,
      // FLUX-801: move an open window to the front (end) of the paint order. Bails when it's absent
      // or already frontmost so a mousedown handler can call it idempotently without churning state.
      raise: (id) =>
        setOpen((prev) =>
          !prev.includes(id) || prev[prev.length - 1] === id ? prev : [...prev.filter((x) => x !== id), id],
        ),
      // FLUX-744: open the ticket's chat window and ensure the sideview is open (idempotent — never
      // toggles an already-open panel shut). The default surface for opening a ticket; cards/search
      // route here instead of the center modal.
      openTicket: (id, from) => {
        openChat(id, from);
        setSideviewOpen((prev) => (prev.includes(id) ? prev : [...prev, id]));
      },
      // FLUX-810: open the orchestrator chat without the ticket sideview (it has no ticket panel).
      openBoard: (from) => openChat(BOARD_CONVERSATION_ID, from),
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
        // FLUX-727: drop the retired tab from the order so siblings hold position (nothing re-sorts).
        setOrder((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev));
        // FLUX-734: a retired chat also drops its sideview flag — reopening starts collapsed.
        setSideviewOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev));
        // FLUX-623: retiring a chat to History clears its draft — reopening starts empty.
        setDrafts((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // FLUX-666: likewise clear its composer chip selections — reopening starts at the defaults.
        setSelections((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // FLUX-920: drop its stored window geometry — a chat reopened from History starts at the
        // default footprint, and the persisted map stays bounded.
        setWindowGeometryState((prev) => {
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
      // FLUX-666: prune an all-default selection so a reset-to-defaults composer doesn't linger
      // in the map (mirrors the empty-draft prune above). A no-op write (unchanged values) keeps
      // the same object identity so consumers don't churn.
      setSelections: (id, sel) =>
        setSelections((prev) => {
          const model = sel.model ?? '';
          const effort = sel.effort ?? '';
          const permission = sel.permission ?? '';
          if (!model && !effort && !permission) {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }
          const cur = prev[id];
          if (cur && cur.model === model && cur.effort === effort && cur.permission === permission) return prev;
          return { ...prev, [id]: { model, effort, permission } };
        }),
      // FLUX-727: the dragged arrangement leads; ids it omits (inactive-but-remembered) trail it.
      // FLUX-728: cap the in-memory order at 50 (same bound as the localStorage write) so inactive
      // remembered ids can't accumulate unboundedly in state.
      reorder: (ids) =>
        setOrder((prev) => {
          const set = new Set(ids);
          const leftover = prev.filter((x) => !set.has(x));
          return [...ids, ...leftover].slice(0, ORDER_CAP);
        }),
      // FLUX-727: prepend (dedup). Bail when already front so idempotent calls don't churn state.
      // FLUX-728: cap at 50 (matching the storage write) to bound in-memory growth.
      promoteToFront: (id) =>
        setOrder((prev) => (prev[0] === id ? prev : [id, ...prev.filter((x) => x !== id)].slice(0, ORDER_CAP))),
      // FLUX-734: flip the ticket sideview panel for a chat window.
      toggleSideView: (id) =>
        setSideviewOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
      // FLUX-887: idempotently open the sideview (no churn / no accidental close if already open).
      openSideView: (id) =>
        setSideviewOpen((prev) => (prev.includes(id) ? prev : [...prev, id])),
      // FLUX-740: clamp + set the global sideview width (the divider drag is high-frequency, so the
      // setter stays cheap; persistence is debounced by React's batched render via the effect above).
      // FLUX-744: this is the user's explicit choice, so mark the width user-set — later opens keep it.
      setSideviewWidth: (width) => {
        setSideviewWidthState(Math.min(MAX_SIDEVIEW_WIDTH, Math.max(MIN_SIDEVIEW_WIDTH, Math.round(width))));
        if (!widthUserSetRef.current) setSideviewWidthUserSet(true);
      },
      // FLUX-744: seed a proportional (~45%) width from the chat column at open time, bounded by
      // `maxWidth` so the grown window still fits the viewport (the ~45% target is approached, not
      // exceeded, on narrow screens). No-op once the user has dragged the divider, so their explicit
      // width is never overwritten on reopen.
      seedSideviewWidth: (chatWidth, maxWidth) => {
        if (widthUserSetRef.current) return;
        const seeded = Math.round(chatWidth * SIDEVIEW_OPEN_RATIO);
        const upper = Math.max(MIN_SIDEVIEW_WIDTH, Math.min(MAX_SIDEVIEW_WIDTH, maxWidth ?? MAX_SIDEVIEW_WIDTH));
        setSideviewWidthState(Math.min(upper, Math.max(MIN_SIDEVIEW_WIDTH, seeded)));
      },
      // FLUX-740: record a section's explicit open/collapsed override (keyed by section id).
      setSectionOpen: (sectionId, openState) =>
        setSectionOpenState((prev) => (prev[sectionId] === openState ? prev : { ...prev, [sectionId]: openState })),
      // FLUX-920: merge-patch a window's geometry so a size-only commit (`{w,h}` from the resize grip)
      // keeps any stored dragged position and a position-only commit (`{left,bottom}` from the title-bar
      // drag) keeps the stored size. A no-op write (identical values) keeps the same map identity so
      // consumers don't churn.
      setWindowGeometry: (id, geom) =>
        setWindowGeometryState((prev) => {
          const cur = prev[id];
          const next = { ...cur, ...geom } as WindowGeometry;
          if (
            cur &&
            cur.w === next.w &&
            cur.h === next.h &&
            cur.left === next.left &&
            cur.bottom === next.bottom
          ) {
            return prev;
          }
          return { ...prev, [id]: next };
        }),
      // FLUX-1273: open the plan-approval panel for a ticket. FLUX-1381: the nonce bump makes a
      // same-id repeat open observable (the id set alone bails out in React), so a minimized panel
      // reliably restores from every "open plan" entry point.
      openPlanApproval: (id) => { setPlanApprovalOpen(id); setPlanApprovalNonce((n) => n + 1); },
      closePlanApproval: () => setPlanApprovalOpen(null),
    };
  }, []);

  const state = useMemo<DockState>(
    () => ({ open, acked, dismissed, manuallyOpened, anchors, anchorRects, drafts, selections, order, sideviewOpen, sideviewWidth, sideviewWidthUserSet, sectionOpen, windowGeometry, planApprovalOpen, planApprovalNonce }),
    [open, acked, dismissed, manuallyOpened, anchors, anchorRects, drafts, selections, order, sideviewOpen, sideviewWidth, sideviewWidthUserSet, sectionOpen, windowGeometry, planApprovalOpen, planApprovalNonce],
  );

  return (
    <DockActionsContext.Provider value={actions}>
      <DockStateContext.Provider value={state}>
        <DockOpenContext.Provider value={open}>{children}</DockOpenContext.Provider>
      </DockStateContext.Provider>
    </DockActionsContext.Provider>
  );
}

/** FLUX-923: the ids of currently-open (non-minimized) chat windows. Cheap subscription — changes only
 *  on open/close/minimize/raise, never on draft/selection churn. */
// eslint-disable-next-line react-refresh/only-export-components -- canonical context hook, colocated with its provider.
export function useDockOpenIds(): string[] {
  return useContext(DockOpenContext);
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
