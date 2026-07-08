// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CardCommentBadge } from './CardCommentBadge';
import type { TaskCardController } from '../../hooks/useTaskCardController';
import type { Task } from '../../types';

// FLUX-1153: click/hover/title gating must read `totalCommentCount` (the historyDigest-derived
// total), not the inline `comments` array — the list payload caps inline `comments` (full text)
// to the most recent few (FLUX-1144), so a ticket with more comments than fit in that window would
// wrongly gate as "no comments" if anything read the capped length instead.
const TASK: Task = {
  id: 'FLUX-1',
  status: 'Todo',
  title: 'Task with more comments than the inline cap',
  // Inline history is capped to the most recent comment.
  history: [{ type: 'comment', id: 'c5', user: 'alice', date: '2026-01-01T00:00:00Z' }],
  historyDigest: {
    length: 6,
    lastEntry: null,
    lastActivityAt: '2026-01-01T00:00:00Z',
    enteredCurrentStatusAt: null,
    isSpeedDemon: false,
    statusChanges24h: [],
    comments: [
      { id: 'c1', user: 'alice', date: '2025-12-01T00:00:00Z' },
      { id: 'c2', user: 'alice', date: '2025-12-02T00:00:00Z' },
      { id: 'c3', user: 'alice', date: '2025-12-03T00:00:00Z' },
      { id: 'c4', user: 'alice', date: '2025-12-04T00:00:00Z' },
      { id: 'c5', user: 'alice', date: '2025-12-05T00:00:00Z' },
    ],
    requireInput: null,
    planReviewComment: null,
  },
};

const cappedInlineCommentCount = TASK.history!.filter((e) => e.type === 'comment').length;
const totalCommentCount = TASK.historyDigest!.comments.length;

function buildController(overrides: Partial<TaskCardController> = {}): TaskCardController {
  const base = {
    openTaskModal: vi.fn(),
    openCommentPopover: vi.fn((e: React.MouseEvent) => e.stopPropagation()),
    commentCloseTimeout: { current: null },
    setIsHovering: vi.fn(),
    hoverTimeout: { current: null },
    commentHoverTimeout: { current: null },
    commentPopoverOpen: false,
    commentBadgeRef: { current: null },
    setCommentPopoverPos: vi.fn(),
    commentOpenedByHover: { current: false },
    setCommentPopoverOpen: vi.fn(),
    isMouseOverCard: { current: false },
    startDescriptionTimer: vi.fn(),
    isPromptStatus: false,
    hasUnread: false,
    totalCommentCount: 0,
    unreadCommentIds: [] as string[],
    config: undefined,
    ...overrides,
  };
  return base as unknown as TaskCardController;
}

describe('CardCommentBadge gating (FLUX-1153 regression)', () => {
  afterEach(() => {
    cleanup();
  });

  it("models the bug scenario: a task's historyDigest comment count exceeds the capped inline count", () => {
    expect(totalCommentCount).toBeGreaterThan(cappedInlineCommentCount);
  });

  it('clicking opens the comment popover when totalCommentCount > 0, even though the capped inline count would gate it off', () => {
    const c = buildController({ totalCommentCount });
    render(<CardCommentBadge task={TASK} c={c} />);

    fireEvent.click(screen.getByRole('button'));

    expect(c.openCommentPopover).toHaveBeenCalled();
    expect(c.openTaskModal).not.toHaveBeenCalled();
  });

  it('clicking opens the task modal instead when totalCommentCount is 0', () => {
    const c = buildController({ totalCommentCount: 0 });
    render(<CardCommentBadge task={TASK} c={c} />);

    fireEvent.click(screen.getByRole('button'));

    expect(c.openTaskModal).toHaveBeenCalledWith(TASK);
    expect(c.openCommentPopover).not.toHaveBeenCalled();
  });

  it('omits the "Add a comment" title when totalCommentCount > 0', () => {
    const c = buildController({ totalCommentCount });
    render(<CardCommentBadge task={TASK} c={c} />);

    expect(screen.getByRole('button').getAttribute('title')).toBeNull();
  });

  it('shows the "Add a comment" title when totalCommentCount is 0', () => {
    const c = buildController({ totalCommentCount: 0 });
    render(<CardCommentBadge task={TASK} c={c} />);

    expect(screen.getByRole('button').getAttribute('title')).toBe('Add a comment');
  });

  it('hover proceeds past the early-return guard when totalCommentCount > 0', () => {
    const c = buildController({ totalCommentCount, config: { commentHoverPreviewEnabled: true } as never });
    render(<CardCommentBadge task={TASK} c={c} />);

    fireEvent.mouseEnter(screen.getByRole('button'));

    // Guard cleared -> proceeds to cancel pending timers, which the early-return would skip.
    expect(c.setIsHovering).toHaveBeenCalledWith(false);
  });

  it('hover is a no-op (early-return) when totalCommentCount is 0', () => {
    const c = buildController({ totalCommentCount: 0, config: { commentHoverPreviewEnabled: true } as never });
    render(<CardCommentBadge task={TASK} c={c} />);

    fireEvent.mouseEnter(screen.getByRole('button'));

    expect(c.setIsHovering).not.toHaveBeenCalled();
  });

  it('renders the unread count over the total when hasUnread is true', () => {
    const c = buildController({ totalCommentCount, hasUnread: true, unreadCommentIds: ['c4', 'c5'] });
    render(<CardCommentBadge task={TASK} c={c} />);

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText(String(totalCommentCount))).toBeNull();
  });

  it('renders the total comment count when there is no unread comment', () => {
    const c = buildController({ totalCommentCount, hasUnread: false });
    render(<CardCommentBadge task={TASK} c={c} />);

    expect(screen.getByText(String(totalCommentCount))).toBeTruthy();
  });

  it('renders no count badge when totalCommentCount is 0', () => {
    const c = buildController({ totalCommentCount: 0, hasUnread: false });
    render(<CardCommentBadge task={TASK} c={c} />);

    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });
});
