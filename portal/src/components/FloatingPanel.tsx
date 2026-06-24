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

export function FloatingPanel({
  storageKey,
  title,
  defaultWidth = 400,
  defaultHeight = 440,
  onClose,
  children,
}: {
  storageKey: string;
  title: ReactNode;
  defaultWidth?: number;
  defaultHeight?: number;
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
      return { x, y, w, h };
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
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Keep the header reachable: clamp so at least a strip stays on-screen.
    const x = Math.min(vw - 120, Math.max(margin - sizeRef.current.w + 120, drag.current.ox + dx));
    const y = Math.min(vh - 40, Math.max(margin, drag.current.oy + dy));
    setPos({ x, y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    persist();
  };

  return (
    <div
      ref={panelRef}
      className="eh-surface eh-border fixed z-[60] flex flex-col overflow-hidden rounded-xl border shadow-2xl"
      style={{ left: pos.x, top: pos.y, resize: 'both', minWidth: 280, minHeight: 160, maxWidth: '95vw', maxHeight: '90vh' }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex shrink-0 cursor-move touch-none select-none items-center justify-between gap-2 border-b border-[var(--eh-border)] bg-black/5 px-2.5 py-1.5 dark:bg-white/5"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--eh-text-muted)]">
          <GripHorizontal className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Hide"
            className="shrink-0 rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
