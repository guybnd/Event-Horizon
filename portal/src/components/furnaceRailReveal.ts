import { pointerWithin, type CollisionDetection } from '@dnd-kit/core';
import { FURNACE_NEW_DROP_ID } from '../furnaceTypes';

// FLUX-1549: pure predicate for the Furnace quick-drop rail's reveal threshold, split out of Board.tsx
// (react-refresh/only-export-components forbids non-component exports from a component file) so
// Board.test.tsx can cover the threshold logic directly — this test suite doesn't simulate a live
// dnd-kit drag, and this predicate is exactly where the original review-flagged bug lived (see
// `FurnaceQuickDropZone`'s comment in Board.tsx for the full fix). Plain function, not a hook: no
// render/state cost, safe to call on every pointer move from `handleDragMove`.

// How close (px, from the scroller's right edge) the dragged card must get before the rail reveals.
export const FURNACE_RAIL_REVEAL_THRESHOLD_PX = 180;

export function isFurnaceRailRevealTarget(
  translatedRect: { right: number } | null | undefined,
  scrollerRect: { right: number },
): boolean {
  return !!translatedRect && translatedRect.right > scrollerRect.right - FURNACE_RAIL_REVEAL_THRESHOLD_PX;
}

// FLUX-1570: full width of the revealed Furnace quick-drop panel (must match the panel's rendered
// width in Board.tsx's `FurnaceQuickDropZone`) — also the pointer hit-band width `isPointerInFurnaceQuickDrop`
// tests against, so the drop target always matches what's actually visible on screen.
export const FURNACE_QUICK_DROP_WIDTH_PX = 404;

// FLUX-1570: true once the panel is revealed AND the pointer sits within the band it visually
// occupies (inset `FURNACE_QUICK_DROP_WIDTH_PX` from the scroller's right edge, bounded to its
// vertical inset). Used by `makeFurnaceAwareCollision` below to override dnd-kit's own `pointerWithin`
// result — the panel's real `useDroppable` node stays a fixed 40px sliver (FLUX-1549 constraint: never
// resize or transform the measured node), so without this override most of the visible panel isn't
// droppable and drops there fall through to whatever column sits underneath (Done, per FLUX-1570).
export function isPointerInFurnaceQuickDrop(
  pointer: { x: number; y: number } | null | undefined,
  scrollerRect: { top: number; right: number; bottom: number },
  revealed: boolean,
): boolean {
  return (
    revealed &&
    !!pointer &&
    pointer.x > scrollerRect.right - FURNACE_QUICK_DROP_WIDTH_PX &&
    pointer.y > scrollerRect.top &&
    pointer.y < scrollerRect.bottom
  );
}

// FLUX-1570: wraps dnd-kit's `pointerWithin` so the Furnace quick-drop panel's entire visible area is
// droppable, not just the fixed 40px sliver its `useDroppable` node measures (see the width comment
// above). Only overrides while the quick-drop panel is actually mounted (`!furnaceOpen && activeTask`,
// mirrored via `isQuickDropMounted`) — with the drawer open, its own batch-card droppables must win
// untouched. A factory (not a closure defined inline in Board) so the override logic itself is
// unit-testable without spinning up a live dnd-kit drag.
export function makeFurnaceAwareCollision(opts: {
  isQuickDropMounted: () => boolean;
  getScrollerRect: () => { top: number; right: number; bottom: number } | null;
}): CollisionDetection {
  return (args) => {
    const base = pointerWithin(args);
    if (!opts.isQuickDropMounted()) return base;
    const scrollerRect = opts.getScrollerRect();
    if (!scrollerRect) return base;
    const revealed = isFurnaceRailRevealTarget(args.collisionRect, scrollerRect);
    if (isPointerInFurnaceQuickDrop(args.pointerCoordinates, scrollerRect, revealed)) {
      return [{ id: FURNACE_NEW_DROP_ID }];
    }
    return base;
  };
}
