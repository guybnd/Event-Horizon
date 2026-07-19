import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate } from 'framer-motion';
import { useMotionTokens } from './tokens';

interface PendingFlight {
  taskId: string;
  fromRect: DOMRect;
}

interface ActiveFlight {
  clone: HTMLElement;
  controls: ReturnType<typeof animate>;
}

/**
 * FLUX-1507: one-shot "card flight" between board columns. Hooks the `applyStatusChange`
 * optimistic-commit boundary (Board.tsx) — `beginFlight(taskId)` measures the card's rect ONCE,
 * synchronously, before the status-change state update moves it; a `useLayoutEffect` then
 * measures its NEW rect the instant the DOM reflects the move and flies a `position: fixed`
 * clone from old → new with the shared spatial spring. The clone is a raw DOM `cloneNode`, not a
 * second React-rendered `<TaskCard>` — no extra mount cost, and it never touches the real card's
 * (React-owned) styles, so there's nothing to fight on the next re-render.
 *
 * Zero per-render cost (the FLUX-629 constraint the board's `layoutId` FLIP failed on): both
 * `getBoundingClientRect` calls happen only inside this one imperative sequence, never during a
 * normal render.
 */
export function useCardFlight() {
  const tokens = useMotionTokens();
  const [pending, setPending] = useState<PendingFlight | null>(null);
  const activeFlightsRef = useRef<Map<string, ActiveFlight>>(new Map());

  const beginFlight = useCallback((taskId: string) => {
    if (tokens.instant) return;

    // Retarget: a flight is already in progress for this task. Capture the still-flying
    // clone's CURRENT on-screen position (not the card's original rest position) as the new
    // flight's start, then cancel and remove the stale clone — the new flight picks up
    // visually where the old one was, instead of stacking a second overlapping clone.
    const existing = activeFlightsRef.current.get(taskId);
    let fromRect: DOMRect;
    if (existing) {
      fromRect = existing.clone.getBoundingClientRect();
      existing.controls.stop();
      existing.clone.remove();
      activeFlightsRef.current.delete(taskId);
    } else {
      const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
      if (!el) return;
      fromRect = el.getBoundingClientRect();
    }
    setPending({ taskId, fromRect });
  }, [tokens.instant]);

  useLayoutEffect(() => {
    if (!pending) return;
    const { taskId, fromRect } = pending;
    setPending(null);

    const toEl = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (!toEl) return;
    const toRect = toEl.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    // Reorder within the same visual slot (e.g. a same-column no-op) — nothing to fly.
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

    const clone = toEl.cloneNode(true) as HTMLElement;
    clone.style.position = 'fixed';
    clone.style.left = `${toRect.left}px`;
    clone.style.top = `${toRect.top}px`;
    clone.style.width = `${toRect.width}px`;
    clone.style.height = `${toRect.height}px`;
    clone.style.margin = '0';
    clone.style.zIndex = '70';
    clone.style.pointerEvents = 'none';
    clone.style.willChange = 'transform';
    clone.setAttribute('aria-hidden', 'true');
    // Inert the clone's own interactive descendants — it's a flight visual, not a live card;
    // stray ids also make it invisible to `document.querySelector('[data-task-id]')` lookups.
    clone.removeAttribute('data-task-id');
    clone.querySelectorAll('[data-task-id]').forEach((node) => node.removeAttribute('data-task-id'));

    document.body.appendChild(clone);

    const controls = animate(clone, { x: [dx, 0], y: [dy, 0] }, tokens.spring);
    const cleanup = () => {
      // Only clear the map entry if it's still this clone's — a later retrigger for the same
      // taskId may have already replaced it (stopping this animation asynchronously rejects
      // its "finished" promise, so this cleanup can fire after a newer flight has registered).
      if (activeFlightsRef.current.get(taskId)?.clone === clone) {
        activeFlightsRef.current.delete(taskId);
      }
      clone.remove();
    };
    activeFlightsRef.current.set(taskId, { clone, controls });
    controls.then(cleanup).catch(cleanup);
  }, [pending, tokens.spring]);

  // Belt-and-suspenders: drop any in-flight clone if the board itself unmounts mid-animation.
  useEffect(() => () => {
    activeFlightsRef.current.forEach(({ clone }) => clone.remove());
    activeFlightsRef.current.clear();
  }, []);

  return { beginFlight };
}
