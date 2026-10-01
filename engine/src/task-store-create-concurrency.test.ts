import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getActiveFluxDir } from './workspace.js';
import { createTask } from './task-store.js';

// FLUX-1756: two concurrent createTask calls both scanned the cache for the max id, both awaited the
// remote max, and both minted the same id — observed live twice; the second time the write replaced
// the first ticket's file. Allocation now runs on a per-workspace chain. This test is the exact
// shape that failed: N creates started in the same tick.

describe('createTask under concurrency (FLUX-1756)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-create-conc-'));
    setWorkspaceRoot(root);
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('mints distinct ids for creates started in the same tick, and every file exists', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createTask({ title: `Ticket ${i}`, author: 'Tester', skipBroadcast: true })),
    );
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) {
      const file = path.join(getActiveFluxDir(), `${id}.md`);
      const content = await fs.readFile(file, 'utf-8');
      expect(content).toContain(`id: ${id}`);
    }
  });

  it('keeps scratch and project namespaces on independent counters', async () => {
    const [a, b, c] = await Promise.all([
      createTask({ title: 'A', author: 'Tester', skipBroadcast: true }),
      createTask({ title: '', author: 'Tester', kind: 'scratch', skipBroadcast: true }),
      createTask({ title: 'C', author: 'Tester', skipBroadcast: true }),
    ]);
    expect(a.id).toMatch(/^FLUX-\d+$/);
    expect(b.id).toMatch(/^SCRATCH-\d+$/);
    expect(c.id).toMatch(/^FLUX-\d+$/);
    expect(a.id).not.toBe(c.id);
  });
});
