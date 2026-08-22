// FLUX-1653: git-backed doc revision history routes — `git log --follow` already stores every
// version of a doc, these routes just surface it read-only. Uses a REAL temp git repo (not a
// mocked runner) so `--follow` across a rename and the root-commit `git show` edge case are
// exercised for real, mirroring diff-aggregator.test.ts's convention.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';

// Real git subprocesses are slow on Windows under parallel suite load (mirrors diff-aggregator.test.ts).
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

describe('GET /api/docs/:docPath/revisions* (FLUX-1653)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-docs-revisions-'));
    await git(root, ['init', '-b', 'master']);
    await git(root, ['config', 'user.email', 'test@test.com']);
    await git(root, ['config', 'user.name', 'Test']);
    await fs.mkdir(path.join(root, '.docs'), { recursive: true });
    setWorkspaceRoot(root);

    const { default: docsRouter } = await import('./docs.js');
    const app = express();
    app.use(express.json());
    app.use('/api/docs', requireWorkspace, docsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function writeAndCommit(relPath: string, content: string, message: string) {
    const filePath = path.join(root, relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    await git(root, ['add', '--', relPath]);
    await git(root, ['commit', '-m', message]);
  }

  it('lists every commit touching the doc, newest first, with hash/author/date/message', async () => {
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nv1\n', 'add guide v1');
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nv2\n', 'update guide to v2');

    const res = await fetch(`${baseUrl}/api/docs/guide/revisions`);
    expect(res.status).toBe(200);
    const { revisions } = await res.json();
    expect(revisions).toHaveLength(2);
    expect(revisions[0].message).toBe('update guide to v2');
    expect(revisions[1].message).toBe('add guide v1');
    for (const rev of revisions) {
      expect(rev.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(rev.author).toBe('Test');
      expect(rev.date).toBeTruthy();
    }
  });

  it('parses a ticketId from the commit subject (FLUX-1672)', async () => {
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nv1\n', 'Add guide (FLUX-100) (#200)');
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nv2\n', 'FLUX-101: tweak guide wording');
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nv3\n', 'Reference an off-board key ANZUBRAI-26');
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nv4\n', 'Fix UTF-8 encoding, no ticket here');

    const res = await fetch(`${baseUrl}/api/docs/guide/revisions`);
    const { revisions } = await res.json();
    expect(revisions.map((r: { ticketId: string | null }) => r.ticketId)).toEqual([
      null, // "Fix UTF-8 encoding..." — denylisted false-positive shape, no real key
      'ANZUBRAI-26', // off-board key, no known project — generic fallback
      'FLUX-101', // inline "KEY-N: ..." subject
      'FLUX-100', // merge-style "... (KEY-N) (#PR)" subject
    ]);
  });

  it('follows history across a rename (git log --follow)', async () => {
    await writeAndCommit('.docs/old-name.md', '---\ntitle: Old\n---\nbody\n', 'create doc');
    await git(root, ['mv', '.docs/old-name.md', '.docs/new-name.md']);
    await git(root, ['commit', '-m', 'rename doc']);

    const res = await fetch(`${baseUrl}/api/docs/new-name/revisions`);
    const { revisions } = await res.json();
    expect(revisions.map((r: { message: string }) => r.message)).toEqual(['rename doc', 'create doc']);
  });

  it('returns an empty list (never a 500) for an untracked doc', async () => {
    await fs.mkdir(path.join(root, '.docs'), { recursive: true });
    await fs.writeFile(path.join(root, '.docs', 'untracked.md'), '---\ntitle: U\n---\nbody\n', 'utf-8');

    const res = await fetch(`${baseUrl}/api/docs/untracked/revisions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revisions: [] });
  });

  it('returns a past revision’s content shaped like a Doc record, including the root commit', async () => {
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\norder: 3\n---\nfirst body\n', 'add guide');
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\norder: 3\n---\nsecond body\n', 'update guide');

    const listRes = await fetch(`${baseUrl}/api/docs/guide/revisions`);
    const { revisions } = await listRes.json();
    const rootHash = revisions[1].hash;

    const res = await fetch(`${baseUrl}/api/docs/guide/revisions/${rootHash}`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.path).toBe('guide');
    expect(doc.title).toBe('Guide');
    expect(doc.order).toBe(3);
    expect(doc.body.trim()).toBe('first body');
  });

  it('404s for an unknown revision hash instead of 500ing', async () => {
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nbody\n', 'add guide');
    const res = await fetch(`${baseUrl}/api/docs/guide/revisions/deadbeef00000000000000000000000000000000`);
    expect(res.status).toBe(404);
  });

  it('returns the unified diff for one revision, including the root commit (no parent)', async () => {
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nfirst body\n', 'add guide');
    await writeAndCommit('.docs/guide.md', '---\ntitle: Guide\n---\nsecond body\n', 'update guide');

    const listRes = await fetch(`${baseUrl}/api/docs/guide/revisions`);
    const { revisions } = await listRes.json();
    const [latest, rootRevision] = revisions;

    const latestDiff = await fetch(`${baseUrl}/api/docs/guide/revisions/${latest.hash}/diff`);
    expect(latestDiff.status).toBe(200);
    const latestDiffText = await latestDiff.text();
    expect(latestDiffText).toContain('-first body');
    expect(latestDiffText).toContain('+second body');

    // Root commit has no parent — `git show` must still succeed (diffed against the empty tree).
    const rootDiff = await fetch(`${baseUrl}/api/docs/guide/revisions/${rootRevision.hash}/diff`);
    expect(rootDiff.status).toBe(200);
    expect(await rootDiff.text()).toContain('+first body');
  });
});
