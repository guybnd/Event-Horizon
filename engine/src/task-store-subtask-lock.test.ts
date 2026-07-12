import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { updateTaskWithHistory } from './task-store.js';

/**
 * FLUX-987 (audit finding C2) regression guard. create_ticket's parent-link write used to do its
 * own unlocked read-modify-write of the parent's `subtasks` (fs.readFile → push → atomicWriteFile,
 * then a wholesale `tasksCache[parentId]` overwrite), independent of the per-ticket write lock
 * (serializeTicketWrite) that updateTaskWithHistory goes through. A concurrent updateTaskWithHistory
 * write on the SAME parent (add_note / change_status / another create_ticket) landing in the same
 * window could interleave with it and drop history/subtasks either way — mirrors FLUX-992's
 * updateAgentSession-vs-updateTaskWithHistory race, this time between two updateTaskWithHistory
 * calls, one of them using the new `appendSubtask` option that replaced the racy inline code.
 */
describe('updateTaskWithHistory appendSubtask is serialized with a concurrent write to the same parent (FLUX-987 / C2)', () => {
  const parentId = 'FLUX-1';
  const childId = 'FLUX-2';
  let fluxDir: string;
  let ticketPath: string;

  beforeEach(async () => {
    fluxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-subtask-lock-'));
    ticketPath = path.join(fluxDir, `${parentId}.md`);

    await fs.writeFile(
      ticketPath,
      matter.stringify('body', { id: parentId, title: 'Parent', status: 'In Progress', swimlane: null, subtasks: [], history: [] }),
    );

    getWorkspace().tasks[parentId] = {
      id: parentId,
      title: 'Parent',
      status: 'In Progress',
      swimlane: null,
      subtasks: [],
      history: [],
      _path: ticketPath,
    };
  });

  afterEach(async () => {
    delete getWorkspace().tasks[parentId];
    vi.restoreAllMocks();
    await fs.rm(fluxDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a subtask link and a concurrent swimlane/history write on the same parent both survive', async () => {
    // Both calls read the parent at ~t=0, before either has written — the shape of the race.
    // Make the subtask-link write land first and the swimlane write land second (via a longer
    // delay), which is exactly the ordering that would silently drop the subtask link pre-fix:
    // the swimlane write, built from its stale pre-link read, commits last and wins. Post-fix,
    // the shared per-ticket lock forces the second call to read AFTER the first has landed, so
    // this delay ordering can no longer matter.
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [filePath, data] = args;
      if (filePath === `${ticketPath}.tmp` && typeof data === 'string') {
        const subtasks = matter(data).data.subtasks;
        const isSubtaskWrite = Array.isArray(subtasks) && subtasks.includes(childId);
        await new Promise((r) => setTimeout(r, isSubtaskWrite ? 5 : 30));
      }
      return realWriteFile(...args);
    });

    await Promise.all([
      updateTaskWithHistory(parentId, { entries: [], appendSubtask: childId }),
      updateTaskWithHistory(parentId, {
        extraFields: { swimlane: 'require-input' },
        entries: [{ type: 'comment', user: 'Agent', comment: 'concurrent note', date: new Date().toISOString() }],
      }),
    ]);

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    expect(onDisk.data.subtasks).toEqual([childId]);
    expect(onDisk.data.swimlane).toBe('require-input');
    const history = onDisk.data.history as Array<{ comment?: string }>;
    expect(history.some((e) => e.comment === 'concurrent note')).toBe(true);
  });

  it('appendSubtask is idempotent — linking the same child twice does not duplicate it', async () => {
    await updateTaskWithHistory(parentId, { entries: [], appendSubtask: childId });
    await updateTaskWithHistory(parentId, { entries: [], appendSubtask: childId });

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    expect(onDisk.data.subtasks).toEqual([childId]);
  });
});
