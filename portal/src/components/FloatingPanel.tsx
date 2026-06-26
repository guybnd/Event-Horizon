import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GripHorizontal, X } from 'lucide-react';

/**
 * FLUX-722: a lightweight draggable + resizable floating window. Drag by the header; resize from
 * the native bottom-right handle (CSS `resize`); geometry persisted to localStorage under
 * `storageKey`. Position is React-controlled (so dragging re-renders), while size is owned by the
 * browser's resize handle and captured via ResizeObserver — the two never fight over inline style.
 * Used for the pending-interaction fallback so a cramped corner overlay can be moved + sized to
 * taste, like the chat dock windows.
 */
interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

function loadGeometry(key: string): Partial<Geometry> | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<Geometry>) : null;
  } catch {
    return null;
  }
}

function saveGeometry(key: string, g: Geometry) {
  try {
    localStorage.setItem(key, JSON.stringify(g));
  } catch {
    /* storage full / disabled — geometry is a nicety, not load-bearing */
  }
}

/** Margin kept between the panel and the viewport edge (matches the old inline drag margin). */
const VIEWPORT_MARGIN = 8;

/**
 * FLUX-809: clamp a geometry fully within the viewport. Size is capped first (95vw × 90vh —
 * mirrors the `maxWidth`/`maxHeight` on the element), then position is pinned so the whole panel
 * — and therefore its header + resolve controls — always stays on-screen. Shared by the mount
 * seed, the drag handler, and the resize listener so all three obey one rule, fixing windows that
 * spawned off-screen from stale/larger-monitor geometry. The size cap only matters for the seed;
 * after mount the native resize handle owns width/height, so callers re-clamping position pass the
 * live size and ignore the returned w/h.
 */
function clampGeometry(g: Geometry, vw: number, vh: number): Geometry {
  const w = Math.min(g.w, Math.round(vw * 0.95));
  const h = Math.min(g.h, Math.round(vh * 0.9));
  const x = Math.min(Math.max(VIEWPORT_MARGIN, g.x), Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN));
  const y = Math.min(Math.max(VIEWPORT_MARGIN, g.y), Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN));
  return { x, y, w, h };
}

export function FloatingPanel({
  storageKey,
  title,
  defaultWidth = 400,
  defaultHeight = 440,
  tone = 'default',
  pulse = false,
  revealSignal,
  onClose,
  children,
}: {
  storageKey: string;
  title: ReactNode;
  defaultWidth?: number;
  defaultHeight?: number;
  /** FLUX-809: `attention` swaps the neutral surface for a loud amber accent (border + header),
   *  so a "the agent is waiting on you" window reads apart from the calm chat/dock surfaces. */
  tone?: 'default' | 'attention';
  /** FLUX-809: pulse the attention glow (reuses `eh-taskcard-needs-input`) while prompts wait. */
  pulse?: boolean;
  /** FLUX-809: bump this to re-clamp the (already-mounted) window back on-screen — e.g. when the
   *  pinned Pending tab is clicked to "bring it into view". A change after mount re-runs the clamp. */
  revealSignal?: number;
  onClose?: () => void;
  children: ReactNode;
}) {
  const initial = useRef<Geometry>(
    (() => {
      const saved = loadGeometry(storageKey);
      const w = saved?.w ?? defaultWidth;
      const h = saved?.h ?? defaultHeight;
      const margin = 16;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      // Default: bottom-right, sitting just above the chat taskbar.
      const x = saved?.x ?? Math.max(margin, vw - w - margin);
      const y = saved?.y ?? Math.max(margin, vh - h - margin - 88);
      // FLUX-809: clamp the seeded geometry to the live viewport so stale/larger-monitor geometry
      // (or a since-shrunk viewport) can never spawn the window partly/fully off-screen on mount.
      return clampGeometry({ x, y, w, h }, vw, vh);
    })(),
  );

  const [pos, setPos] = useState({ x: initial.current.x, y: initial.current.y });
  const posRef = useRef(pos);
  posRef.current = pos;
  const sizeRef = useRef({ w: initial.current.w, h: initial.current.h });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const persist = useCallback(() => {
    saveGeometry(storageKey, { ...posRef.current, ...sizeRef.current });
  }, [storageKey]);

  // Apply the persisted/default size once; thereafter the native resize handle owns it.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.width = `${sizeRef.current.w}px`;
    el.style.height = `${sizeRef.current.h}px`;
  }, []);

  // FLUX-809: re-clamp on viewport resize / DPI change. If the window shrinks below where the
  // panel sits, nudge it back into view (and persist the correction) so no controls are lost.
  useEffect(() => {
    const onResize = () => {
      const cur = posRef.current;
      const clamped = clampGeometry(
        { x: cur.x, y: cur.y, w: sizeRef.current.w, h: sizeRef.current.h },
        window.innerWidth,
        window.innerHeight,
      );
      if (clamped.x !== cur.x || clamped.y !== cur.y) {
        posRef.current = { x: clamped.x, y: clamped.y };
        setPos({ x: clamped.x, y: clamped.y });
        persist();
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [persist]);

  // FLUX-809: "bring on-screen" — when `revealSignal` changes after mount (the Pending tab was
  // clicked), re-clamp the current position into the live viewport so a window dragged/left out of
  // view snaps back. First run only seeds the baseline (no jump on initial mount).
  const didRevealRef = useRef(false);
  useEffect(() => {
    if (!didRevealRef.current) {
      didRevealRef.current = true;
      return;
    }
    const cur = posRef.current;
    const clamped = clampGeometry(
      { x: cur.x, y: cur.y, w: sizeRef.current.w, h: sizeRef.current.h },
      window.innerWidth,
      window.innerHeight,
    );
    if (clamped.x !== cur.x || clamped.y !== cur.y) {
      posRef.current = { x: clamped.x, y: clamped.y };
      setPos({ x: clamped.x, y: clamped.y });
      persist();
    }
  }, [revealSignal, persist]);

  // Capture user resizes (native CSS handle) into the ref + storage, debounced to a frame.
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        sizeRef.current = { w: el.offsetWidth, h: el.offsetHeight };
        persist();
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [persist]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.sx;
    const dy = e.clientY - drag.current.sy;
    // FLUX-809: share the one clamp rule with mount/resize so a drag can't push the panel (and its
    // resolve controls) off-screen either.
    const clamped = clampGeometry(
      { x: drag.current.ox + dx, y: drag.current.oy + dy, w: sizeRef.current.w, h: sizeRef.current.h },
      window.innerWidth,
      window.innerHeight,
    );
    setPos({ x: clamped.x, y: clamped.y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    persist();
  };

  const attention = tone === 'attention';
  // FLUX-809: an attention window reads as a loud amber surface (accent border + header + optional
  // pulse) instead of the neutral chat/dock surface; the default tone is unchanged.
  const panelClass = attention
    ? 'fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-amber-400/70 bg-[var(--eh-surface)] shadow-2xl shadow-amber-500/20 ring-1 ring-amber-400/40' +
      (pulse ? ' eh-taskcard-needs-input' : '')
    : 'eh-surface eh-border fixed z-[60] flex flex-col overflow-hidden rounded-xl border shadow-2xl';
  const headerClass = attention
    ? 'flex shrink-0 cursor-move touch-none select-none items-center justify-between gap-2 border-b border-amber-400/40 bg-amber-400/15 px-2.5 py-1.5 text-amber-700 dark:text-amber-300'
    : 'flex shrink-0 cursor-move touch-none select-none items-center justify-between gap-2 border-b border-[var(--eh-border)] bg-black/5 px-2.5 py-1.5 text-[var(--eh-text-muted)] dark:bg-white/5';

  return (
    <div
      ref={panelRef}
      className={panelClass}
      style={{ left: pos.x, top: pos.y, resize: 'both', minWidth: 280, minHeight: 160, maxWidth: '95vw', maxHeight: '90vh' }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={headerClass}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold">
          <GripHorizontal className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Hide"
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
