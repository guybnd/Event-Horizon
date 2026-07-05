import { describe, it, expect } from 'vitest';
import { tasksEqual } from './tasksEqual';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'FLUX-1',
    status: 'Todo',
    title: 'A task',
    body: 'Some body text',
    assignee: 'Guy',
    priority: 'High',
    effort: 'M',
    implementationLink: '',
    order: 1,
    tags: ['perf', 'portal'],
    subtasks: ['FLUX-2', 'FLUX-3'],
    // FLUX-725: change-detection reads the list `historyDigest` (length + last-entry key), not raw history.
    historyDigest: {
      length: 1,
      lastEntry: { date: '2026-06-18T00:00:00.000Z', type: 'comment' },
      lastActivityAt: '2026-06-18T00:00:00.000Z',
      enteredCurrentStatusAt: null,
      isSpeedDemon: false,
      statusChanges24h: [],
      comments: [{ id: 'c1', user: 'Guy', date: '2026-06-18T00:00:00.000Z' }],
      requireInput: null,
    },
    ...overrides,
  } as Task;
}

describe('tasksEqual', () => {
  it('returns true for the same reference', () => {
    const t = makeTask();
    expect(tasksEqual(t, t)).toBe(true);
  });

  it('returns true for distinct but field-identical tasks', () => {
    expect(tasksEqual(makeTask(), makeTask())).toBe(true);
  });

  it.each([
    ['status', { status: 'Done' }],
    ['title', { title: 'Changed' }],
    ['assignee', { assignee: 'Sam' }],
    ['priority', { priority: 'Low' }],
    ['effort', { effort: 'XL' }],
    ['implementationLink', { implementationLink: 'https://pr/1' }],
    ['order', { order: 99 }],
  ] as const)('detects a change to %s', (_field, override) => {
    expect(tasksEqual(makeTask(), makeTask(override))).toBe(false);
  });

  it('detects a swimlane being set (null -> set)', () => {
    expect(tasksEqual(makeTask(), makeTask({ swimlane: 'require-input' }))).toBe(false);
  });

  it('detects a swimlane being cleared (set -> null)', () => {
    expect(tasksEqual(makeTask({ swimlane: 'require-input' }), makeTask({ swimlane: null }))).toBe(false);
  });

  it('treats undefined and null swimlane as equal (no false positive per poll)', () => {
    expect(tasksEqual(makeTask({ swimlane: undefined }), makeTask({ swimlane: null }))).toBe(true);
  });

  it('detects a body length change', () => {
    expect(tasksEqual(makeTask({ body: 'short' }), makeTask({ body: 'a much longer body' }))).toBe(false);
  });

  it('detects a body head change at equal length', () => {
    const a = makeTask({ body: 'A'.repeat(50) });
    const b = makeTask({ body: 'B'.repeat(50) });
    expect(tasksEqual(a, b)).toBe(false);
  });

  it('ignores body changes past the first 200 chars when length is equal (matches old signature)', () => {
    const head = 'X'.repeat(200);
    const a = makeTask({ body: head + 'A'.repeat(50) });
    const b = makeTask({ body: head + 'B'.repeat(50) });
    expect(tasksEqual(a, b)).toBe(true);
  });

  it('detects tag reorder and length change', () => {
    expect(tasksEqual(makeTask({ tags: ['a', 'b'] }), makeTask({ tags: ['b', 'a'] }))).toBe(false);
    expect(tasksEqual(makeTask({ tags: ['a'] }), makeTask({ tags: ['a', 'b'] }))).toBe(false);
  });

  it('treats fresh-but-equal tag/subtask arrays as equal (no false positives per poll)', () => {
    expect(tasksEqual(makeTask({ tags: ['x'], subtasks: ['FLUX-9'] }), makeTask({ tags: ['x'], subtasks: ['FLUX-9'] }))).toBe(true);
  });

  it('detects subtask changes for string and inline forms', () => {
    expect(tasksEqual(makeTask({ subtasks: ['FLUX-2'] }), makeTask({ subtasks: ['FLUX-9'] }))).toBe(false);
    expect(
      tasksEqual(
        makeTask({ subtasks: [{ id: 'FLUX-2', status: 'Todo' }] }),
        makeTask({ subtasks: [{ id: 'FLUX-2', status: 'Done' }] }),
      ),
    ).toBe(false);
    expect(
      tasksEqual(
        makeTask({ subtasks: [{ id: 'FLUX-2', title: 'x', status: 'Todo' }] }),
        makeTask({ subtasks: [{ id: 'FLUX-2', title: 'x', status: 'Todo' }] }),
      ),
    ).toBe(true);
  });

  it('detects history digest length and last-entry changes', () => {
    const a = makeTask();
    // A new entry bumps the digest length + last-entry key.
    const b = makeTask({
      historyDigest: { ...a.historyDigest!, length: 2, lastEntry: { date: '2026-06-18T01:00:00.000Z', type: 'activity' } },
    });
    expect(tasksEqual(a, b)).toBe(false);
    // Same length but a different last-entry key (e.g. a status_change replacing the tail) still differs.
    const c = makeTask({ historyDigest: { ...a.historyDigest!, lastEntry: { date: '2026-06-18T00:00:00.000Z', type: 'status_change' } } });
    expect(tasksEqual(a, c)).toBe(false);
  });

  it('detects cliSession status / activity / label changes', () => {
    const base = makeTask({ cliSession: { status: 'running', currentActivity: 'thinking', label: 'agent' } as Task['cliSession'] });
    expect(tasksEqual(base, makeTask({ cliSession: { status: 'completed', currentActivity: 'thinking', label: 'agent' } as Task['cliSession'] }))).toBe(false);
    expect(tasksEqual(base, makeTask({ cliSession: { status: 'running', currentActivity: 'writing', label: 'agent' } as Task['cliSession'] }))).toBe(false);
  });

  it('detects tokenMetadata changes', () => {
    const a = makeTask({ tokenMetadata: { inputTokens: 10, outputTokens: 20, costUSD: 0.1 } });
    const b = makeTask({ tokenMetadata: { inputTokens: 10, outputTokens: 21, costUSD: 0.1 } });
    expect(tasksEqual(a, b)).toBe(false);
    const c = makeTask({ tokenMetadata: { inputTokens: 10, outputTokens: 20, costUSD: 0.1 } });
    expect(tasksEqual(a, c)).toBe(true);
  });

  it('detects artifact changes (latest + revision count)', () => {
    const rev = (rev: number) => ({ rev, createdAt: '2026-06-18T00:00:00.000Z', bytes: 100 });
    const none = makeTask();
    const first = makeTask({ artifacts: { latest: 1, revisions: [rev(1)] } });
    // First publish: undefined -> { latest: 1, revisions: [...] }
    expect(tasksEqual(none, first)).toBe(false);
    // New revision: latest + revisions.length both increment.
    const second = makeTask({ artifacts: { latest: 2, revisions: [rev(1), rev(2)] } });
    expect(tasksEqual(first, second)).toBe(false);
    // Identical artifacts are equal.
    const firstAgain = makeTask({ artifacts: { latest: 1, revisions: [rev(1)] } });
    expect(tasksEqual(first, firstAgain)).toBe(true);
  });
});
