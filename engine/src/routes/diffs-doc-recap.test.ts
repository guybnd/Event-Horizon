// FLUX-1662 (Phase B step 10) — after a self-serve inline doc commit via POST /diffs/file/commit,
// the owning ticket's doc-recap artifact must re-emit a new revision reflecting the edit (never a
// duplicate artifact, never blocking the commit response). Exercises the route end-to-end against a
// real temp git repo + worktree, mirroring docs-commit-on-save.test.ts's harness.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import matter from 'gray-matter';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from '../workspace.js';
import { getWorkspace, runWithWorkspace, Workspace } from '../workspace-context.js';
import { createTask, updateTaskWithHistory } from '../task-store.js';
import { createTaskWorktree } from '../task-worktree.js';
import { readArtifactRevision } from '../artifacts.js';
import { emitDocRecap } from '../doc-recap-emit.js';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

async function gitInit(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await git(root, ['init', '-b', 'master']);
  await git(root, ['config', 'user.email', 'test@test.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);
}

async function headCommit(root: string): Promise<string> {
  const { stdout } = await git(root, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

describe('POST /diffs/file/commit re-emits the owning ticket\'s doc-recap (FLUX-1662)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-diffs-docrecap-'));
    await gitInit(root);
    setWorkspaceRoot(root);
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });

    const { default: diffsRouter } = await import('./diffs.js');
    const app = express();
    app.use(express.json());
    app.use('/api/diffs', diffsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const { listTaskWorktrees } = await import('../task-worktree.js');
      const wts = await listTaskWorktrees(root).catch(() => []);
      for (const w of wts) await git(root, ['worktree', 'remove', '--force', w.path]).catch(() => {});
      await git(root, ['worktree', 'prune']).catch(() => {});
    } catch { /* best-effort */ }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    vi.clearAllMocks();
  });

  async function makeTicketWithBranch(branch: string): Promise<{ id: string; worktree: string; baseline: string }> {
    const baseline = await headCommit(root);
    const { id } = await createTask({ title: 'Docs ticket' });
    await updateTaskWithHistory(id, { updatedBy: 'Test', extraFields: { branch, baselineCommit: baseline } });
    const worktree = await createTaskWorktree(root, id, branch, { linkDependencies: false });
    return { id, worktree, baseline };
  }

  it('a self-serve commit on a ticket branch publishes a kind:doc-recap artifact revision reflecting the edit', async () => {
    const { id } = await makeTicketWithBranch('flux/test-docs-a');
    const content = matter.stringify('Hello world.\n', { title: 'Note', order: 1 });

    const res = await fetch(`${baseUrl}/api/diffs/file/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'flux/test-docs-a', path: '.docs/note.md', content, message: 'add note', push: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hash).toBeTruthy();

    const task = getWorkspace().tasks[id];
    // FLUX-1667: the auto doc-recap now publishes into its own `docRecap` channel, independent of
    // the `plan` channel's `artifacts` (which stays untouched by this purely-recap flow).
    expect(task?.docRecap?.latest).toBe(1);
    expect(task?.docRecap?.revisions[0]?.kind).toBe('doc-recap');
    expect(task?.artifacts).toBeUndefined();

    const rev = await readArtifactRevision(id, 'latest', task?.docRecap);
    expect(rev).not.toBeNull();
    expect(rev!.html).toContain('data-eh-doc-path=".docs/note.md"');
    expect(rev!.html).toContain('Hello world.');
  });

  it('a second self-serve commit appends a new revision on the SAME artifact, never a duplicate card', async () => {
    const { id } = await makeTicketWithBranch('flux/test-docs-b');
    const firstContent = matter.stringify('First body.\n', { title: 'Note', order: 1 });
    await fetch(`${baseUrl}/api/diffs/file/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'flux/test-docs-b', path: '.docs/note.md', content: firstContent, message: 'add note', push: false }),
    });
    const afterFirst = getWorkspace().tasks[id]?.docRecap;
    expect(afterFirst?.latest).toBe(1);

    const secondContent = matter.stringify('Second body — edited.\n', { title: 'Note', order: 1 });
    const res = await fetch(`${baseUrl}/api/diffs/file/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'flux/test-docs-b', path: '.docs/note.md', content: secondContent, message: 'edit note', push: false }),
    });
    expect(res.status).toBe(200);

    const task = getWorkspace().tasks[id];
    expect(task?.docRecap?.latest).toBe(2);
    expect(task?.docRecap?.revisions).toHaveLength(2);

    const latestRev = await readArtifactRevision(id, 'latest', task?.docRecap);
    expect(latestRev!.html).toContain('Second body — edited.');
    expect(latestRev!.html).not.toContain('First body.');
  });

  it('persists an auto-emitted pointer in its owning workspace even when a different workspace is ambient', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-diffs-docrecap-other-'));
    const otherWs = new Workspace();
    otherWs.root = otherRoot;
    try {
      await gitInit(otherRoot);
      await fs.mkdir(path.join(otherRoot, '.flux'), { recursive: true });
      const baseline = await headCommit(otherRoot);
      const branch = 'flux/test-docs-explicit-workspace';
      const { id } = await runWithWorkspace(otherWs, () => createTask({ title: 'Other workspace docs' }, otherWs));
      await runWithWorkspace(otherWs, () => updateTaskWithHistory(
        id,
        { updatedBy: 'Test', extraFields: { branch, baselineCommit: baseline } },
        otherWs,
      ));
      const worktree = await createTaskWorktree(otherRoot, id, branch, { linkDependencies: false });
      await fs.mkdir(path.join(worktree, '.docs'), { recursive: true });
      await fs.writeFile(path.join(worktree, '.docs', 'other.md'), matter.stringify('Other workspace body.\n', { title: 'Other' }), 'utf8');
      await git(worktree, ['add', '.docs/other.md']);
      await git(worktree, ['commit', '-m', 'add other doc']);

      // The test's regular root remains the ambient/default workspace. The explicit workspace
      // argument must carry BOTH the artifact sidecar and the frontmatter pointer to otherRoot.
      const ambientPointerBefore = structuredClone(getWorkspace().tasks[id]?.docRecap);
      await emitDocRecap(id, branch, baseline, otherWs);

      expect(otherWs.tasks[id]?.docRecap?.latest).toBe(1);
      expect(getWorkspace().tasks[id]?.docRecap).toEqual(ambientPointerBefore);
      const onDisk = matter(await fs.readFile(otherWs.tasks[id]._path, 'utf8'));
      expect(onDisk.data.docRecap).toMatchObject({ latest: 1 });
      const revision = await runWithWorkspace(otherWs, () => readArtifactRevision(id, 'latest', otherWs.tasks[id].docRecap));
      expect(revision?.html).toContain('Other workspace body.');
    } finally {
      const { listTaskWorktrees } = await import('../task-worktree.js');
      const worktrees = await listTaskWorktrees(otherRoot).catch(() => []);
      for (const worktree of worktrees) await git(otherRoot, ['worktree', 'remove', '--force', worktree.path]).catch(() => {});
      await fs.rm(otherRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('logs the original error when the pointer write fails after its sidecar is created', async () => {
    const branch = 'flux/test-docs-pointer-write-log';
    const { id, worktree, baseline } = await makeTicketWithBranch(branch);
    await fs.mkdir(path.join(worktree, '.docs'), { recursive: true });
    await fs.writeFile(path.join(worktree, '.docs', 'failure.md'), matter.stringify('Failure fixture.\n', { title: 'Failure' }), 'utf8');
    await git(worktree, ['add', '.docs/failure.md']);
    await git(worktree, ['commit', '-m', 'add failure fixture']);

    const task = getWorkspace().tasks[id];
    const originalPath = task._path;
    task._path = path.join(root, 'missing-parent', `${id}.md`);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await emitDocRecap(id, branch, baseline);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[doc-recap] emit failed for ${id} on branch ${branch}:`),
        expect.any(Error),
      );
    } finally {
      task._path = originalPath;
      errorSpy.mockRestore();
    }
  });

  it('a refused commit (ref === main) never touches any ticket\'s artifacts', async () => {
    const { id } = await makeTicketWithBranch('flux/test-docs-c');
    const content = matter.stringify('Body.\n', { title: 'Note', order: 1 });

    const res = await fetch(`${baseUrl}/api/diffs/file/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', path: '.docs/note.md', content, message: 'add note', push: false }),
    });
    expect(res.status).toBe(409);
    expect(getWorkspace().tasks[id]?.artifacts).toBeUndefined();
    expect(getWorkspace().tasks[id]?.docRecap).toBeUndefined();
  });
});
