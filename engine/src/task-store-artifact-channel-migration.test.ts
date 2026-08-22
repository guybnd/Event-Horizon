import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';

const broadcastEvent = vi.fn();
vi.mock('./events.js', () => ({
  broadcastEvent: (...args: unknown[]) => broadcastEvent(...args),
  bumpTasksVersion: vi.fn(),
}));

import { initDir } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';

/**
 * FLUX-1667 (decision 3) — `partitionArtifactChannels` (task-store.ts) is the pure, idempotent
 * read-path normalizer that splits a legacy mixed `artifacts` stream (from before the auto
 * doc-recap got its own `docRecap` channel) into the two typed channels on every load. It must run
 * at BOTH seams that populate the API-served `ws.tasks` map — `loadTaskInner` (cold boot / file
 * watcher) and the boot-index warm-path `onHit` (a cached hit never touches `loadTaskInner`) — so
 * these tests drive `initDir()` end-to-end twice per scenario (cold, then warm) exactly like
 * task-store-boot-index.test.ts, since the behavior that matters is what `ws.tasks` ends up
 * holding after each boot path, not the helper's internals in isolation.
 */
describe('partitionArtifactChannels migration (FLUX-1667)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    broadcastEvent.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-artifact-migration-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  const mixedArtifacts = {
    latest: 2,
    revisions: [
      { rev: 1, kind: 'doc-recap', createdAt: '2026-01-01T00:00:00.000Z', bytes: 100 },
      { rev: 2, title: 'Mockup', createdAt: '2026-01-02T00:00:00.000Z', bytes: 200 },
    ],
  };

  async function writeMixedTicket(id: string) {
    await fs.writeFile(
      path.join(fluxDir, `${id}.md`),
      matter.stringify('body', { id, title: 'Mixed', status: 'Todo', artifacts: mixedArtifacts }),
    );
  }

  it('splits a legacy mixed artifacts stream on a COLD load (loadTaskInner)', async () => {
    await writeMixedTicket('FLUX-1');
    await initDir();

    const task = getWorkspace().tasks['FLUX-1'];
    expect(task?.docRecap?.latest).toBe(1);
    expect(task?.docRecap?.revisions).toHaveLength(1);
    expect(task?.docRecap?.revisions[0]?.kind).toBe('doc-recap');
    expect(task?.artifacts?.latest).toBe(2);
    expect(task?.artifacts?.revisions).toHaveLength(1);
    expect(task?.artifacts?.revisions[0]?.title).toBe('Mockup');
    // Never persisted back to frontmatter — the on-disk file still carries the legacy mixed shape.
    const onDisk = matter(await fs.readFile(path.join(fluxDir, 'FLUX-1.md'), 'utf8'));
    expect(onDisk.data.docRecap).toBeUndefined();
    expect(onDisk.data.artifacts.revisions).toHaveLength(2);
  });

  it('splits the same mixed stream on a WARM load (boot-index cache hit, never touching loadTaskInner)', async () => {
    await writeMixedTicket('FLUX-2');
    await initDir(); // cold boot: writes the boot index
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

    await initDir(); // warm boot: served from the persisted boot-index cache via partitionByBootIndex's onHit

    const task = getWorkspace().tasks['FLUX-2'];
    expect(task?.docRecap?.latest).toBe(1);
    expect(task?.docRecap?.revisions).toHaveLength(1);
    expect(task?.artifacts?.latest).toBe(2);
    expect(task?.artifacts?.revisions).toHaveLength(1);
  });

  it('is idempotent — a ticket with no doc-recap-kind revision is returned unchanged (docRecap never materializes)', async () => {
    await fs.writeFile(
      path.join(fluxDir, 'FLUX-3.md'),
      matter.stringify('body', {
        id: 'FLUX-3',
        title: 'Plan only',
        status: 'Todo',
        artifacts: { latest: 1, revisions: [{ rev: 1, title: 'Mockup', createdAt: '2026-01-01T00:00:00.000Z', bytes: 50 }] },
      }),
    );
    await initDir();

    const task = getWorkspace().tasks['FLUX-3'];
    expect(task?.artifacts?.latest).toBe(1);
    expect(task?.artifacts?.revisions).toHaveLength(1);
    expect(task?.docRecap).toBeUndefined();
  });

  it('empties `artifacts` entirely when every revision is doc-recap-kind', async () => {
    await fs.writeFile(
      path.join(fluxDir, 'FLUX-4.md'),
      matter.stringify('body', {
        id: 'FLUX-4',
        title: 'All doc-recap',
        status: 'Todo',
        artifacts: { latest: 1, revisions: [{ rev: 1, kind: 'doc-recap', createdAt: '2026-01-01T00:00:00.000Z', bytes: 50 }] },
      }),
    );
    await initDir();

    const task = getWorkspace().tasks['FLUX-4'];
    expect(task?.artifacts).toBeUndefined();
    expect(task?.docRecap?.latest).toBe(1);
    expect(task?.docRecap?.revisions).toHaveLength(1);
  });

  it('does NOT clobber a materialized docRecap pointer that already has revisions newer than the legacy mixed artifacts stream', async () => {
    // Reachable via the normal migration path: a legacy-mixed ticket gets a real doc-recap emit
    // (emitDocRecap / publish_artifact channel:'doc-recap'). That write reads disk frontmatter —
    // still the mixed `artifacts`, migration is in-memory only — and Object.assigns the new
    // `docRecap` pointer onto it, so disk ends up with BOTH the still-legacy `artifacts` AND a
    // `docRecap` pointer containing revisions the legacy split has never seen (e.g. rev 3 here).
    await fs.writeFile(
      path.join(fluxDir, 'FLUX-5.md'),
      matter.stringify('body', {
        id: 'FLUX-5',
        title: 'Legacy mixed + materialized docRecap',
        status: 'Todo',
        artifacts: mixedArtifacts, // still legacy: rev 1 doc-recap, rev 2 mockup
        docRecap: {
          latest: 3,
          revisions: [
            { rev: 1, kind: 'doc-recap', createdAt: '2026-01-01T00:00:00.000Z', bytes: 100 },
            { rev: 3, kind: 'doc-recap', createdAt: '2026-01-03T00:00:00.000Z', bytes: 300 },
          ],
        },
      }),
    );
    await initDir();

    const task = getWorkspace().tasks['FLUX-5'];
    // rev 3 must survive the re-split — the whole point of this fix.
    expect(task?.docRecap?.latest).toBe(3);
    expect(task?.docRecap?.revisions.map((r: { rev: number }) => r.rev).sort()).toEqual([1, 3]);
    // The plan side is unaffected.
    expect(task?.artifacts?.latest).toBe(2);
    expect(task?.artifacts?.revisions).toHaveLength(1);
    expect(task?.artifacts?.revisions[0]?.title).toBe('Mockup');
  });
});
