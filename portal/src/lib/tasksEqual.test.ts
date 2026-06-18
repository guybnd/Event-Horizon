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
    history: [
      { type: 'comment', user: 'Guy', date: '2026-06-18T00:00:00.000Z', comment: 'hi' },
    ],
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

  it('detects history length and last-entry changes', () => {
    const a = makeTask();
    const b = makeTask({ history: [...(a.history ?? []), { type: 'activity', user: 'Guy', date: '2026-06-18T01:00:00.000Z', comment: 'x' }] });
    expect(tasksEqual(a, b)).toBe(false);
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
});
