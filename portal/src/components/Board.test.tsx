// @vitest-environment jsdom
import { Profiler, useCallback, useState, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Board } from './Board';
import {
  FURNACE_QUICK_DROP_WIDTH_PX,
  FURNACE_RAIL_REVEAL_THRESHOLD_PX,
  isFurnaceRailRevealTarget,
  isPointerInFurnaceQuickDrop,
  makeFurnaceAwareCollision,
} from './furnaceRailReveal';
import { FURNACE_NEW_DROP_ID } from '../furnaceTypes';
import { DockProvider } from './DockProvider';
import { ToastProvider } from '../hooks/useNotify';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

// FLUX-1141: regression test for the AppContent → Board cascade found while profiling
// interaction latency (FLUX-1141/FLUX-1135). Board sits directly under AppContent alongside
// ChatDock/TaskModal (App.tsx); before this fix none of the three were React.memo'd, so an
// unrelated sibling state change (terminal panel toggle, furnace drawer toggle, the 5s
// furnace-status poll) re-invoked Board's full ~700-line body — and reconciled every Column/
// TaskCard — even though Board's own props never changed. This test reproduces that exact
// shape (a parent with local state re-rendering a stable-props child) with the real Board.

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    appendFurnaceTicket: vi.fn().mockResolvedValue({}),
    createFurnaceBatch: vi.fn().mockResolvedValue({}),
    sendTaskCliInput: vi.fn().mockResolvedValue({}),
    detachWorktree: vi.fn().mockResolvedValue({}),
  };
});

// Any action any descendant (Board, TaskCard's controller, DockProvider consumers) might pull
// off useAppActions()/useDockActions() — a Proxy avoids hand-enumerating both hooks' full shape.
function stubActions<T extends object>(): T {
  return new Proxy({}, { get: () => vi.fn() }) as T;
}

const CONFIG: Config = {
  columns: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' }],
  hiddenStatuses: [{ name: 'Require Input' }, { name: 'Archived' }],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: false,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  animationsEnabled: false,
};

// A board-sized task list (~80 cards across 4 columns) — big enough that a full unmemoized
// re-render of Board's column/card tree is measurable, in the neighborhood of the ~127-card
// board this fix was profiled against (see the FLUX-1141 completion comment).
const STATUSES = ['Todo', 'In Progress', 'Ready', 'Done'];
const TASKS: Task[] = Array.from({ length: 80 }, (_, i) => ({
  id: `FLUX-${1000 + i}`,
  status: STATUSES[i % STATUSES.length]!,
  title: `Synthetic task ${i}`,
  order: i,
}));

function Harness({ children }: { children: (toggle: () => void) => ReactNode }) {
  const [unrelatedToggle, setUnrelatedToggle] = useState(false);
  // Mirrors AppContent's handleToggleTerminal (App.tsx) — a stable useCallback-wrapped setter.
  const toggle = useCallback(() => setUnrelatedToggle((o) => !o), []);
  return (
    <>
      <div data-testid="unrelated-flag">{String(unrelatedToggle)}</div>
      {children(toggle)}
    </>
  );
}

function renderBoard(onRender: ProfilerOnRenderCallback) {
  const actions = stubActions<AppActions>();
  appStore.patch({ tasks: TASKS, config: CONFIG, tasksLoading: false, currentProject: 'test-project' });

  const onCloseFurnace = () => {}; // stable across renders — Board never receives a fresh one from App.tsx either

  render(
    <ToastProvider>
      <AppActionsContext.Provider value={actions}>
        <DockProvider>
          <Harness>
            {(toggleUnrelated) => (
              <>
                <button onClick={toggleUnrelated}>toggle unrelated</button>
                <Profiler id="board" onRender={onRender}>
                  <Board furnaceOpen={false} onCloseFurnace={onCloseFurnace} />
                </Profiler>
              </>
            )}
          </Harness>
        </DockProvider>
      </AppActionsContext.Provider>
    </ToastProvider>,
  );
}

describe('Board memoization (FLUX-1141)', () => {
  afterEach(() => cleanup());

  it(
    'does not re-render when an unrelated sibling state toggles (stable props)',
    async () => {
      const commits: Array<{ phase: string; actualDuration: number }> = [];
      renderBoard((_id, phase, actualDuration) => commits.push({ phase, actualDuration }));

      // Data is already in the store before render (no async loading state), so the initial mount
      // is synchronous — assert on it directly rather than via `findBy*`, whose internal polling
      // would otherwise burn enough wall-clock for unrelated per-second timers deeper in the tree
      // (e.g. Column's live-session clock) to tick and add noise unrelated to the bug under test.
      expect(screen.getByText('Synthetic task 0')).toBeTruthy();

      // Board defers several filter/search values via useDeferredValue (FLUX-1200); flush any
      // low-priority catch-up render those schedule on mount before counting commits, so mount
      // settling isn't misattributed to the toggle below (FLUX-1220).
      await act(async () => {});

      const commitsBeforeToggle = commits.length;
      expect(commitsBeforeToggle).toBeGreaterThan(0);

      fireEvent.click(screen.getByText('toggle unrelated'));
      expect(screen.getByTestId('unrelated-flag').textContent).toBe('true');

      // The whole point of the fix: Board's memo comparator bails on the unrelated update. In
      // practice React's Profiler still fires once more for bookkeeping even on a full bailout, but
      // its actualDuration is now negligible — nothing like the ~hundreds-of-ms mount/settle commits
      // above, which reconcile all 80 synthetic cards. Assert on cost, not raw commit count.
      // Threshold has some headroom above the sub-millisecond steady state to absorb JIT/CI-runner
      // noise on the bail-out render itself (FLUX-1220).
      const newCommits = commits.slice(commitsBeforeToggle);
      for (const c of newCommits) {
        expect(c.actualDuration).toBeLessThan(15);
      }
    },
    10000,
  );
});

// FLUX-1519: cold-boot cascade. The instant/reduced-motion path is the regression guard the AC
// calls for — it must stay a genuine no-op wrapper, not just a zero-duration animation, so a card
// list of any size never pays for framer-motion mounting on every card.
describe('Cold-boot cascade (FLUX-1519)', () => {
  afterEach(() => cleanup());

  function renderBoardWithConfig(config: Config) {
    const actions = stubActions<AppActions>();
    appStore.patch({ tasks: TASKS, config, tasksLoading: false, currentProject: 'test-project' });
    const { container } = render(
      <ToastProvider>
        <AppActionsContext.Provider value={actions}>
          <DockProvider>
            <Board furnaceOpen={false} onCloseFurnace={() => {}} />
          </DockProvider>
        </AppActionsContext.Provider>
      </ToastProvider>,
    );
    return container;
  }

  it('animationsEnabled:false renders columns/cards with no entrance transform (instant no-op path)', async () => {
    const container = renderBoardWithConfig(CONFIG);
    await act(async () => {});

    const firstColumn = container.querySelector('[data-column-id="Todo"]');
    expect(firstColumn).toBeTruthy();
    // No inline opacity/transform from a framer entrance — a real no-op, not a zero-duration one.
    expect(firstColumn!.getAttribute('style')).not.toMatch(/opacity/);

    const firstCardWrapper = container.querySelector('[data-task-id="FLUX-1000"]')!.parentElement!;
    // The card tier skips the motion.div wrapper entirely off the entrance path (unlike the column
    // tier, which always renders motion.div but with initial={false}) — plain `<div>`, no style.
    expect(firstCardWrapper.getAttribute('style')).toBeNull();
  });

  it('plays once on cold boot (animations on): columns/top cards fade in, capped at 4, never replays', async () => {
    const ANIMATED_CONFIG: Config = { ...CONFIG, animationsEnabled: true };
    const container = renderBoardWithConfig(ANIMATED_CONFIG);
    await act(async () => {});

    const firstColumn = container.querySelector('[data-column-id="Todo"]');
    expect(firstColumn!.getAttribute('style')).toMatch(/opacity:\s*0/);

    // Todo has 20 synthetic tasks (80 tasks / 4 columns) — first 4 card wrappers animate in...
    const todoCardIds = TASKS.filter((t) => t.status === 'Todo').slice(0, 5).map((t) => t.id);
    for (const id of todoCardIds.slice(0, 4)) {
      const wrapper = container.querySelector(`[data-task-id="${id}"]`)!.parentElement!;
      expect(wrapper.getAttribute('style')).toMatch(/opacity:\s*0/);
    }
    // ...the 5th+ card is exactly today's markup — no wrapper style at all.
    const fifthWrapper = container.querySelector(`[data-task-id="${todoCardIds[4]}"]`)!.parentElement!;
    expect(fifthWrapper.getAttribute('style')).toBeNull();

    // `hasBooted` flips on a macrotask after mount settles (Board.tsx) — flush a real timer tick so
    // the gate is actually armed before simulating the next update, same as it would be in the
    // browser by the time any refetch/SSE event could plausibly arrive.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Simulate a refetch/SSE update on the same mounted Board instance (not a remount): a brand-new
    // task appears at the front of Todo. If the cascade replayed, this never-before-rendered card
    // would get an entrance wrapper same as the original top 4 did above; the `hasBooted` ref must
    // gate that from happening. (Not asserting on the *existing* column/card styles here — their
    // original entrance animation is still legitimately playing out in real time and its interim
    // opacity value is a moving target, not a signal of replay.)
    const newTask: Task = { id: 'FLUX-9999', status: 'Todo', title: 'Freshly arrived via refetch', order: -1 };
    await act(async () => {
      appStore.patch({ tasks: [newTask, ...TASKS] });
    });
    const newCardWrapper = container.querySelector('[data-task-id="FLUX-9999"]')!.parentElement!;
    expect(newCardWrapper.getAttribute('style')).toBeNull();
  });
});

// FLUX-1540: cold-boot "feels stuck" fix. While tasks are still loading, Board must render a
// visibly animated, textful loading state — never a blank/frozen frame — and show real ramping
// progress once the engine's `bootProgress` SSE event starts landing in the store.
describe('Cold-boot loading state (FLUX-1540)', () => {
  afterEach(() => cleanup());

  function renderLoadingBoard() {
    const actions = stubActions<AppActions>();
    appStore.patch({ tasks: [], config: CONFIG, tasksLoading: true, bootProgress: null, currentProject: 'test-project' });
    const { container } = render(
      <ToastProvider>
        <AppActionsContext.Provider value={actions}>
          <DockProvider>
            <Board furnaceOpen={false} onCloseFurnace={() => {}} />
          </DockProvider>
        </AppActionsContext.Provider>
      </ToastProvider>,
    );
    return container;
  }

  it('renders visible animated text while tasks are loading, with no bootProgress data yet', async () => {
    const container = renderLoadingBoard();
    await act(async () => {});

    expect(screen.getByText('Starting Event Horizon…')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
    // Indeterminate fallback — never a stuck/static 0/0 count.
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
  });

  it('renders a ramping "Loaded X / Y tickets" count with a determinate bar from bootProgress', async () => {
    const container = renderLoadingBoard();
    await act(async () => {
      appStore.patch({ bootProgress: { loaded: 300, total: 1200, phase: 'scanning' } });
    });

    expect(screen.getByText('Loading tickets… 300 / 1,200')).toBeTruthy();
    const bar = container.querySelector('[style*="width: 25%"]');
    expect(bar).toBeTruthy();

    await act(async () => {
      appStore.patch({ bootProgress: { loaded: 900, total: 1200, phase: 'scanning' } });
    });
    expect(screen.getByText('Loading tickets… 900 / 1,200')).toBeTruthy();
  });

  it('resets the ramping count on a new scan (lower total) instead of pinning at the old max (FLUX-1543)', async () => {
    const container = renderLoadingBoard();
    await act(async () => {
      appStore.patch({ bootProgress: { loaded: 1525, total: 1525, phase: 'ready' } });
    });
    expect(screen.getByText('Loading tickets… 1,525 / 1,525')).toBeTruthy();

    // A destructive workspace switch re-runs the engine scan, restarting at a smaller total —
    // the count must track the new scan, not clamp against the previous scan's max.
    await act(async () => {
      appStore.patch({ bootProgress: { loaded: 50, total: 300, phase: 'scanning' } });
    });
    expect(screen.getByText('Loading tickets… 50 / 300')).toBeTruthy();
    const bar = container.querySelector('[style*="width: 17%"]');
    expect(bar).toBeTruthy();
  });

  it('a 503-while-activating (no tasks yet, tasksLoading stays true) keeps the loading state up, not an empty board', async () => {
    // Mirrors what AppContext's loadTasks() does on a 503/fetch error before the first successful
    // load: tasksLoading is left/forced true and tasks stays empty — Board must keep showing the
    // loading state, never an empty-board flash or an error UI.
    const container = renderLoadingBoard();
    await act(async () => {});

    expect(container.querySelector('[data-column-id="Todo"]')).toBeNull();
    expect(screen.getByText('Starting Event Horizon…')).toBeTruthy();
  });
});

// FLUX-1547 Phase 4: the "Loaded X / Y" count must tween smoothly toward each new `bootProgress`
// SSE value instead of jumping straight to it (the engine batches these in ~50-ticket stacks
// today, but the cadence is an engine-side detail that may change — the tween must read as a
// continuous count-up regardless). These tests turn animations ON (the suite above runs with
// `CONFIG.animationsEnabled: false`, which makes the roll an instant no-op and would mask this
// entirely) and drive the ~400ms roll with fake timers, mirroring `AnimatedCount.test.tsx`.
describe('Cold-boot progress tween (FLUX-1547)', () => {
  const ANIMATED_CONFIG: Config = { ...CONFIG, animationsEnabled: true } as Config;

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderAnimatedLoadingBoard() {
    const actions = stubActions<AppActions>();
    appStore.patch({
      tasks: [], config: ANIMATED_CONFIG, tasksLoading: true, bootProgress: null, currentProject: 'test-project',
    });
    const { container } = render(
      <ToastProvider>
        <AppActionsContext.Provider value={actions}>
          <DockProvider>
            <Board furnaceOpen={false} onCloseFurnace={() => {}} />
          </DockProvider>
        </AppActionsContext.Provider>
      </ToastProvider>,
    );
    return container;
  }

  it('does not jump straight to a distant bootProgress value — the mid-roll count sits strictly between the old and new value', () => {
    vi.useFakeTimers();
    renderAnimatedLoadingBoard();

    act(() => {
      appStore.patch({ bootProgress: { loaded: 1200, total: 1200, phase: 'scanning' } });
    });
    // Immediately after the SSE patch, the roll has not advanced yet — still at the pre-roll value.
    expect(screen.getByText('Loading tickets… 0 / 1,200')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(120); });
    const midText = screen.getByText(/Loading tickets…/).textContent!;
    const mid = Number(midText.match(/Loading tickets… ([\d,]+) \//)![1].replace(/,/g, ''));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1200);

    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('Loading tickets… 1,200 / 1,200')).toBeTruthy();
  });

  it('a phase:"ready" event that arrives before the previous roll finishes still resolves to the exact final count', () => {
    vi.useFakeTimers();
    renderAnimatedLoadingBoard();

    act(() => {
      appStore.patch({ bootProgress: { loaded: 900, total: 1200, phase: 'scanning' } });
    });
    // Retarget mid-roll, before the first roll (toward 900) has completed.
    act(() => { vi.advanceTimersByTime(120); });
    act(() => {
      appStore.patch({ bootProgress: { loaded: 1200, total: 1200, phase: 'ready' } });
    });

    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('Loading tickets… 1,200 / 1,200')).toBeTruthy();

    // No stale timer still nudging the count past the final value.
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('Loading tickets… 1,200 / 1,200')).toBeTruthy();
  });
});

// FLUX-1549: regression guard for the drag-lag fix. FLUX-1533 reserved scroller `paddingRight`
// (animated over 200ms) whenever a drag was active, squishing every `flex-1` column and re-flowing
// all their cards on drag-start. The fix removes that reservation entirely — the Furnace quick-drop
// target is a zero-footprint overlay instead. No dnd-kit drag harness needed: this asserts on the
// scroller's static markup, which no longer varies with `activeTask` at all.
describe('Furnace quick-drop is a zero-reflow overlay (FLUX-1549)', () => {
  afterEach(() => cleanup());

  it('scroller carries no padding-right reservation or transition, regardless of drag state', async () => {
    const actions = stubActions<AppActions>();
    appStore.patch({ tasks: TASKS, config: CONFIG, tasksLoading: false, currentProject: 'test-project' });
    const { container } = render(
      <ToastProvider>
        <AppActionsContext.Provider value={actions}>
          <DockProvider>
            <Board furnaceOpen={false} onCloseFurnace={() => {}} />
          </DockProvider>
        </AppActionsContext.Provider>
      </ToastProvider>,
    );
    await act(async () => {});

    const scroller = container.querySelector('[data-testid="board-scroller"]')!;
    expect(scroller).toBeTruthy();
    expect(scroller.className).not.toMatch(/padding-right/);
    expect(scroller.getAttribute('style')).toBeNull();
  });
});

// FLUX-1549 review fix: dnd-kit measures a droppable's collision rect once at drag-start and never
// re-measures it as a CSS `transform` animates, so the reveal predicate below — not exercised by the
// zero-reflow test above, and not driveable through a simulated dnd-kit drag in this test suite — is
// exactly where the original bug lived (the droppable's hit-area froze at its pre-reveal position).
// Covering the predicate directly guards the reveal threshold itself; the fix that keeps the real
// `useDroppable` node's geometry fixed regardless of this value lives in `FurnaceQuickDropZone`.
describe('Furnace rail reveal threshold (FLUX-1549)', () => {
  it('reveals once the dragged card crosses the threshold from the scroller right edge', () => {
    const scrollerRect = { right: 1000 } as DOMRect;
    // Card's right edge is exactly at the threshold boundary — not yet past it.
    expect(isFurnaceRailRevealTarget({ right: 1000 - FURNACE_RAIL_REVEAL_THRESHOLD_PX } as DOMRect, scrollerRect)).toBe(false);
    // One pixel past the boundary — reveals.
    expect(isFurnaceRailRevealTarget({ right: 1000 - FURNACE_RAIL_REVEAL_THRESHOLD_PX + 1 } as DOMRect, scrollerRect)).toBe(true);
    // Far from the edge — stays hidden.
    expect(isFurnaceRailRevealTarget({ right: 200 } as DOMRect, scrollerRect)).toBe(false);
  });

  it('stays hidden when there is no live translated rect yet', () => {
    expect(isFurnaceRailRevealTarget(null, { right: 1000 } as DOMRect)).toBe(false);
    expect(isFurnaceRailRevealTarget(undefined, { right: 1000 } as DOMRect)).toBe(false);
  });
});

// FLUX-1570: a card dropped anywhere on the visible Furnace quick-drop panel (not just the fixed
// 40px sliver dnd-kit actually measures — the FLUX-1549 constraint) was falling through to whatever
// column sat underneath (Done), silently mis-filing the ticket. `isPointerInFurnaceQuickDrop` is the
// geometry seam and `makeFurnaceAwareCollision` is the `pointerWithin` override built on top of it —
// both testable without simulating a live dnd-kit drag, same rationale as the reveal-threshold tests.
describe('Furnace quick-drop pointer hit-band (FLUX-1570)', () => {
  const scrollerRect = { top: 0, right: 1000, bottom: 800 } as DOMRect;

  it('is true only when revealed AND the pointer sits within the full panel band', () => {
    // Not revealed yet: even a pointer deep inside the band stays false.
    expect(isPointerInFurnaceQuickDrop({ x: 900, y: 400 }, scrollerRect, false)).toBe(false);
    // Revealed, pointer mid-panel — well past the old 40px sliver, this is the bug this ticket fixes.
    expect(isPointerInFurnaceQuickDrop({ x: 900, y: 400 }, scrollerRect, true)).toBe(true);
    // Revealed, pointer left of the panel's horizontal band.
    expect(isPointerInFurnaceQuickDrop({ x: 1000 - FURNACE_QUICK_DROP_WIDTH_PX - 1, y: 400 }, scrollerRect, true)).toBe(false);
    // Revealed, pointer outside the panel's vertical inset.
    expect(isPointerInFurnaceQuickDrop({ x: 900, y: -5 }, scrollerRect, true)).toBe(false);
  });

  it('stays false with no live pointer coordinates', () => {
    expect(isPointerInFurnaceQuickDrop(null, scrollerRect, true)).toBe(false);
    expect(isPointerInFurnaceQuickDrop(undefined, scrollerRect, true)).toBe(false);
  });
});

describe('makeFurnaceAwareCollision (FLUX-1570)', () => {
  const scrollerRect = { top: 0, right: 1000, bottom: 800 } as DOMRect;
  // collisionRect.right = 900 is past the reveal threshold (scrollerRect.right - 180 = 820), so the
  // panel is "revealed" for these args — mirrors what handleDragMove computes from the same rect.
  const baseArgs = {
    active: { id: 'task-1' },
    droppableRects: new Map(),
    droppableContainers: [],
    pointerCoordinates: { x: 900, y: 400 },
    collisionRect: { right: 900 },
  };

  it('overrides to the Furnace drop id when the panel is mounted and the pointer is in-band', () => {
    const detect = makeFurnaceAwareCollision({
      isQuickDropMounted: () => true,
      getScrollerRect: () => scrollerRect,
    });
    expect(detect(baseArgs as unknown as Parameters<typeof detect>[0])).toEqual([{ id: FURNACE_NEW_DROP_ID }]);
  });

  it('falls back to the base pointerWithin result when the quick-drop panel is not mounted (drawer open)', () => {
    const detect = makeFurnaceAwareCollision({
      isQuickDropMounted: () => false,
      getScrollerRect: () => scrollerRect,
    });
    expect(detect(baseArgs as unknown as Parameters<typeof detect>[0])).toEqual([]);
  });

  it('falls back to the base result when the pointer is outside the panel band', () => {
    const detect = makeFurnaceAwareCollision({
      isQuickDropMounted: () => true,
      getScrollerRect: () => scrollerRect,
    });
    const args = { ...baseArgs, pointerCoordinates: { x: 200, y: 400 } };
    expect(detect(args as unknown as Parameters<typeof detect>[0])).toEqual([]);
  });

  it('falls back to the base result when there is no scroller rect yet', () => {
    const detect = makeFurnaceAwareCollision({
      isQuickDropMounted: () => true,
      getScrollerRect: () => null,
    });
    expect(detect(baseArgs as unknown as Parameters<typeof detect>[0])).toEqual([]);
  });
});
