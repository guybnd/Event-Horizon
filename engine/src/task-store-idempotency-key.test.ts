import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { updateTaskWithHistory } from './task-store.js';

/**
 * FLUX-1428 — updateTaskWithHistory's idempotencyKey dedup. No production caller currently uses
 * this (pr-cleanup.ts's merge-to-Done and pr-tickets.ts's review-decision mirror both ended up
 * `derived: true` instead, since a recurring poll already re-derives them for free — see the
 * ticket's Ready comment for why). Exercised directly here so the primitive itself is proven
 * correct and ready for the next caller that genuinely needs it: a one-shot external action with
 * no natural periodic re-check, where a write lost to a sync race would otherwise vanish for good
 * instead of being replayed by the journal.
 */
describe('updateTaskWithHistory — idempotencyKey dedup (FLUX-1428)', () => {
  const taskId = 'FLUX-1';
  let fluxDir: string;
  let ticketPath: string;

  beforeEach(async () => {
    fluxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-idempotency-key-'));
    ticketPath = path.join(fluxDir, `${taskId}.md`);

    const history = [{ type: 'activity', user: 'Agent', comment: 'Created ticket.', date: '2026-07-01T00:00:00.000Z' }];
    await fs.writeFile(
      ticketPath,
      matter.stringify('body', { id: taskId, title: 'PR-mirror ticket', status: 'In Progress', history }),
    );

    getWorkspace().tasks[taskId] = {
      id: taskId,
      title: 'PR-mirror ticket',
      status: 'In Progress',
      history,
      _path: ticketPath,
    };
  });

  afterEach(async () => {
    delete getWorkspace().tasks[taskId];
    await fs.rm(fluxDir, { recursive: true, force: true }).catch(() => {});
  });

  it('applies the first call and stamps the key; a replay with the same key is a clean no-op', async () => {
    const first = await updateTaskWithHistory(taskId, { nextStatus: 'Done', idempotencyKey: 'pr-42-merged' });
    expect(first?.status).toBe('Done');

    const afterFirst = matter(await fs.readFile(ticketPath, 'utf-8'));
    expect(afterFirst.data.status).toBe('Done');
    const historyAfterFirst = afterFirst.data.history as Array<Record<string, unknown>>;
    const statusChange = historyAfterFirst.find((e) => e.type === 'status_change');
    expect(statusChange?.idempotencyKey).toBe('pr-42-merged');
    const entryCountAfterFirst = historyAfterFirst.length;

    // Simulates the losing side of a sync race replaying this exact op against a head that
    // already carries the key (e.g. because the winning side applied it first) — must not
    // double-apply the status change or append a second history entry.
    const replay = await updateTaskWithHistory(taskId, { nextStatus: 'Done', idempotencyKey: 'pr-42-merged' });
    expect(replay?.status).toBe('Done');

    const afterReplay = matter(await fs.readFile(ticketPath, 'utf-8'));
    const historyAfterReplay = afterReplay.data.history as Array<Record<string, unknown>>;
    expect(historyAfterReplay.length).toBe(entryCountAfterFirst);
    expect(historyAfterReplay.filter((e) => e.type === 'status_change')).toHaveLength(1);
  });

  it('a different idempotencyKey is treated as a distinct op and still applies', async () => {
    await updateTaskWithHistory(taskId, { nextStatus: 'Done', idempotencyKey: 'pr-42-merged' });

    const second = await updateTaskWithHistory(taskId, {
      entries: [{ type: 'comment', user: 'Agent', comment: 'CI failed on retry', date: '2026-07-01T00:05:00.000Z' }],
      idempotencyKey: 'ci-abc123-fail',
    });
    expect(second).not.toBeNull();

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    const history = onDisk.data.history as Array<Record<string, unknown>>;
    expect(history.some((e) => e.idempotencyKey === 'pr-42-merged')).toBe(true);
    expect(history.some((e) => e.idempotencyKey === 'ci-abc123-fail')).toBe(true);
  });
});
