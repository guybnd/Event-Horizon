import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyOptimisticStatusChange, runChangeStatus, runFinishBranchless } from './ticketActions';
import type { HistoryDigest, Task } from '../types';
import type { DiffOverview } from '../api';

vi.mock('../api', () => ({ updateTask: vi.fn().mockResolvedValue(undefined) }));

function makeDigest(overrides: Partial<HistoryDigest> = {}): HistoryDigest {
  return {
    length: 3,
    lastEntry: { date: '2026-06-18T00:00:00.000Z', type: 'comment' },
    lastActivityAt: '2026-06-18T00:00:00.000Z',
    enteredCurrentStatusAt: '2026-06-17T00:00:00.000Z',
    isSpeedDemon: false,
    statusChanges24h: [{ from: 'Todo', to: 'In Progress', date: '2026-06-18T00:00:00.000Z' }],
    comments: [{ id: 'c1', user: 'Guy', date: '2026-06-18T00:00:00.000Z' }],
    requireInput: null,
    planReviewComment: null,
    ...overrides,
  };
}

describe('applyOptimisticStatusChange', () => {
  it('bumps length by 1 when there is no comment', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');
    expect(result.length).toBe(base.length + 1);
  });

  it('bumps length by 2 when a comment is included', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', 'Done, ship it', 'Guy');
    expect(result.length).toBe(base.length + 2);
  });

  it('treats a whitespace-only comment as no comment (bumps by 1)', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', '   ', 'Guy');
    expect(result.length).toBe(base.length + 1);
  });

  it('sets lastEntry, lastActivityAt, and enteredCurrentStatusAt to now', () => {
    const base = makeDigest();
    const before = Date.now();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');
    const after = Date.now();

    expect(result.lastEntry).toEqual({ date: result.lastActivityAt, type: 'status_change' });
    expect(result.enteredCurrentStatusAt).toBe(result.lastActivityAt);

    const stamped = new Date(result.lastActivityAt).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('appends a from/to/date entry to statusChanges24h without dropping prior entries', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');

    expect(result.statusChanges24h).toHaveLength(base.statusChanges24h.length + 1);
    expect(result.statusChanges24h[0]).toEqual(base.statusChanges24h[0]);
    const appended = result.statusChanges24h[result.statusChanges24h.length - 1];
    expect(appended.from).toBe('In Progress');
    expect(appended.to).toBe('Ready');
    expect(appended.date).toBe(result.lastActivityAt);
  });

  it('leaves comments and requireInput untouched', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');
    expect(result.comments).toBe(base.comments);
    expect(result.requireInput).toBe(base.requireInput);
  });

  it('falls back to an empty digest when base is undefined', () => {
    const result = applyOptimisticStatusChange(undefined, 'Todo', 'In Progress', undefined, 'Guy');
    expect(result.length).toBe(1);
    expect(result.statusChanges24h).toEqual([{ from: 'Todo', to: 'In Progress', date: result.lastActivityAt }]);
    expect(result.comments).toEqual([]);
    expect(result.requireInput).toBeNull();
  });
});

// ── FLUX-1359: runChangeStatus / runFinishBranchless drive their flow through an injected
// `PromptResolver` + `ErrorNotifier` instead of native window.prompt/alert — these are the
// testable seam that replaces the untestable DOM dialogs. `updateTask` is mocked so
// `changeTaskStatus` (called internally) never hits the network. ──

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 'FLUX-1', status: 'In Progress', title: 'Test ticket', order: 0, ...overrides } as Task;
}

describe('runChangeStatus', () => {
  beforeEach(async () => {
    const { updateTask } = await import('../api');
    vi.mocked(updateTask).mockReset();
  });

  it('needsComment: resolver returns a comment → changeTaskStatus is called and onDone fires', async () => {
    const { updateTask } = await import('../api');
    vi.mocked(updateTask).mockResolvedValueOnce(undefined as never);
    const prompt = vi.fn().mockResolvedValue('Shipped it');
    const notifyError = vi.fn();
    const onDone = vi.fn();

    await runChangeStatus({
      task: makeTask(),
      newStatus: 'Ready',
      currentUser: 'Guy',
      needsComment: true,
      requireInputStatus: 'Require Input',
      prompt,
      notifyError,
      onDone,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('needsComment: resolver cancels (null) → changeTaskStatus is NOT called', async () => {
    const { updateTask } = await import('../api');
    vi.mocked(updateTask).mockClear();
    const onDone = vi.fn();

    await runChangeStatus({
      task: makeTask(),
      newStatus: 'Ready',
      currentUser: 'Guy',
      needsComment: true,
      requireInputStatus: 'Require Input',
      prompt: vi.fn().mockResolvedValue(null),
      notifyError: vi.fn(),
      onDone,
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reactive retry: a missing-comment rejection re-invokes the resolver and retries with the entered comment', async () => {
    const { updateTask } = await import('../api');
    vi.mocked(updateTask)
      .mockRejectedValueOnce(new Error('A comment is required to move this ticket'))
      .mockResolvedValueOnce(undefined as never);
    const prompt = vi.fn().mockResolvedValue('Added the missing comment');
    const notifyError = vi.fn();
    const onDone = vi.fn();

    await runChangeStatus({
      task: makeTask(),
      newStatus: 'Ready',
      currentUser: 'Guy',
      needsComment: false,
      requireInputStatus: 'Require Input',
      prompt,
      notifyError,
      onDone,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('reactive retry: cancelling (or leaving empty) the retry prompt makes no second call', async () => {
    const { updateTask } = await import('../api');
    vi.mocked(updateTask).mockRejectedValueOnce(new Error('A comment is required to move this ticket'));
    const onDone = vi.fn();

    await runChangeStatus({
      task: makeTask(),
      newStatus: 'Ready',
      currentUser: 'Guy',
      needsComment: false,
      requireInputStatus: 'Require Input',
      prompt: vi.fn().mockResolvedValue('   '),
      notifyError: vi.fn(),
      onDone,
    });

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('genuine failure: a non-missing-comment rejection notifies once and resolves (does not throw)', async () => {
    const { updateTask } = await import('../api');
    vi.mocked(updateTask).mockRejectedValueOnce(new Error('Network error'));
    const notifyError = vi.fn();
    const onDone = vi.fn();

    await expect(
      runChangeStatus({
        task: makeTask(),
        newStatus: 'Ready',
        currentUser: 'Guy',
        needsComment: false,
        requireInputStatus: 'Require Input',
        prompt: vi.fn(),
        notifyError,
        onDone,
      }),
    ).resolves.toBeUndefined();

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][0]).toContain('FLUX-1');
    expect(onDone).not.toHaveBeenCalled();
  });
});

function makeOverview(files: string[]): DiffOverview {
  return {
    groups: [
      {
        kind: 'main',
        path: '/main',
        files: files.map((file) => ({ file, additions: 1, deletions: 0, status: 'modified' as const })),
      },
    ],
    collisions: [],
  };
}

describe('runFinishBranchless', () => {
  it('clean tree (0 files) falls back to dispatchFinish without prompting', async () => {
    const dispatchFinish = vi.fn().mockResolvedValue(undefined);
    const prompt = vi.fn();
    const finishBranchless = vi.fn();

    await runFinishBranchless({
      task: makeTask(),
      prompt,
      notifyError: vi.fn(),
      onDone: vi.fn(),
      dispatchFinish,
      fetchDiffOverview: vi.fn().mockResolvedValue(makeOverview([])),
      finishBranchless,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(dispatchFinish).toHaveBeenCalledTimes(1);
    expect(finishBranchless).not.toHaveBeenCalled();
  });

  it('an unavailable diff overview falls back to dispatchFinish without prompting', async () => {
    const dispatchFinish = vi.fn().mockResolvedValue(undefined);
    const prompt = vi.fn();

    await runFinishBranchless({
      task: makeTask(),
      prompt,
      notifyError: vi.fn(),
      onDone: vi.fn(),
      dispatchFinish,
      fetchDiffOverview: vi.fn().mockRejectedValue(new Error('offline')),
      finishBranchless: vi.fn(),
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(dispatchFinish).toHaveBeenCalledTimes(1);
  });

  it('files present: prompts with the file-list message, then finishes with the entered message', async () => {
    const finishBranchless = vi.fn().mockResolvedValue({ finished: true, hash: 'abc123', link: '' });
    const onDone = vi.fn();
    const prompt = vi.fn().mockResolvedValue('Ship the fix');

    await runFinishBranchless({
      task: makeTask({ id: 'FLUX-2', title: 'Fix the bug' }),
      prompt,
      notifyError: vi.fn(),
      onDone,
      dispatchFinish: vi.fn(),
      fetchDiffOverview: vi.fn().mockResolvedValue(makeOverview(['src/a.ts', 'src/b.ts'])),
      finishBranchless,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    const req = prompt.mock.calls[0][0];
    expect(req.message).toContain('src/a.ts');
    expect(req.message).toContain('src/b.ts');
    expect(finishBranchless).toHaveBeenCalledWith('FLUX-2', { files: ['src/a.ts', 'src/b.ts'], message: 'Ship the fix' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('empty message: notifies and does not finish', async () => {
    const finishBranchless = vi.fn();
    const notifyError = vi.fn();

    await runFinishBranchless({
      task: makeTask(),
      prompt: vi.fn().mockResolvedValue('   '),
      notifyError,
      onDone: vi.fn(),
      dispatchFinish: vi.fn(),
      fetchDiffOverview: vi.fn().mockResolvedValue(makeOverview(['src/a.ts'])),
      finishBranchless,
    });

    expect(finishBranchless).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('cancelling the prompt (null) does not finish', async () => {
    const finishBranchless = vi.fn();

    await runFinishBranchless({
      task: makeTask(),
      prompt: vi.fn().mockResolvedValue(null),
      notifyError: vi.fn(),
      onDone: vi.fn(),
      dispatchFinish: vi.fn(),
      fetchDiffOverview: vi.fn().mockResolvedValue(makeOverview(['src/a.ts'])),
      finishBranchless,
    });

    expect(finishBranchless).not.toHaveBeenCalled();
  });

  it('finishBranchless rejecting notifies instead of throwing', async () => {
    const notifyError = vi.fn();

    await expect(
      runFinishBranchless({
        task: makeTask(),
        prompt: vi.fn().mockResolvedValue('Ship it'),
        notifyError,
        onDone: vi.fn(),
        dispatchFinish: vi.fn(),
        fetchDiffOverview: vi.fn().mockResolvedValue(makeOverview(['src/a.ts'])),
        finishBranchless: vi.fn().mockRejectedValue(new Error('server exploded')),
      }),
    ).resolves.toBeUndefined();

    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});
