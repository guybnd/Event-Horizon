// FLUX-1655: a viewer save can become a real git commit — the local docs PUT accepts an optional
// `revisionMessage`/`author`/`baseHash`, and when `docsCommitOnSave` resolves true, commits the
// single saved file (pathspec-scoped) with the given message/author. `baseHash` guards against an
// external edit landing between load and save (409 `doc-conflict`, file left untouched). These
// tests exercise the route end-to-end in a real temp git repo, mirroring diff-aggregator.test.ts's
// gitInit pattern (real git worktree ops are slow on Windows under parallel load — see its comment).

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
import { setWorkspaceRoot } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { getConfig } from './config.js';
import { loadDoc, loadGroupDoc } from './task-store.js';
import { getDocsDir } from './file-utils.js';
import type { GroupContext } from './group.js';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

vi.mock('./group-edit.js', () => ({
  submitGroupEdit: vi.fn(async (writer: GroupContext, edits: Array<{ path: string; content?: string; delete?: boolean }>) => {
    const fsMod = await import('fs/promises');
    const pathMod = await import('path');
    for (const edit of edits) {
      const abs = pathMod.join(writer.groupStoreDir, ...edit.path.split('/'));
      await fsMod.mkdir(pathMod.dirname(abs), { recursive: true });
      await fsMod.writeFile(abs, edit.content ?? '', 'utf8');
    }
    return { applied: edits.map((e) => e.path), sync: { pushed: [], skipped: [], errors: [] } };
  }),
}));

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

async function commitCount(root: string): Promise<number> {
  const { stdout } = await git(root, ['log', '--oneline']);
  return stdout.trim().split('\n').filter(Boolean).length;
}

describe('docs routes — save-as-revision commit-on-save (FLUX-1655)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-docs-commit-'));
    await gitInit(root);
    setWorkspaceRoot(root);
    await fs.mkdir(getDocsDir(), { recursive: true });

    const { default: docsRouter } = await import('./routes/docs.js');
    const app = express();
    app.use(express.json());
    app.use('/api/docs', docsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    vi.clearAllMocks();
  });

  async function writeLocalDoc(docPath: string, frontmatter: Record<string, unknown>, body: string) {
    const filePath = path.join(getDocsDir(), ...docPath.split('/')) + '.md';
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, matter.stringify(body, frontmatter), 'utf-8');
    await loadDoc(filePath);
    return filePath;
  }

  it('save with a revision message produces exactly one commit containing only that doc file', async () => {
    await writeLocalDoc('note', { title: 'Note' }, 'Original body');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'seed note']);
    const baseline = await commitCount(root);

    const res = await fetch(`${baseUrl}/api/docs/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'New body', revisionMessage: 'Update note', author: 'Ada' }),
    });
    expect(res.status).toBe(200);
    expect(await commitCount(root)).toBe(baseline + 1);

    const { stdout: nameOnly } = await git(root, ['show', '--name-only', '--format=', 'HEAD']);
    expect(nameOnly.trim().split('\n').filter(Boolean)).toEqual(['.docs/note.md']);

    const { stdout: subject } = await git(root, ['log', '-1', '--format=%s']);
    expect(subject.trim()).toBe('Update note');
    const { stdout: authorName } = await git(root, ['log', '-1', '--format=%an']);
    expect(authorName.trim()).toBe('Ada');
  });

  it('an unrelated dirty file in the tree is not swept into the doc commit', async () => {
    await writeLocalDoc('note', { title: 'Note' }, 'Original body');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'seed note']);
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'dirty working-tree change\n', 'utf8');

    const res = await fetch(`${baseUrl}/api/docs/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'New body', revisionMessage: 'Update note' }),
    });
    expect(res.status).toBe(200);

    const { stdout: nameOnly } = await git(root, ['show', '--name-only', '--format=', 'HEAD']);
    expect(nameOnly.trim().split('\n').filter(Boolean)).toEqual(['.docs/note.md']);

    const { stdout: status } = await git(root, ['status', '--porcelain', 'unrelated.txt']);
    expect(status.trim()).toBe('?? unrelated.txt');
  });

  it('a stale baseHash (external edit landed first) is rejected with 409 and the file is left untouched', async () => {
    await writeLocalDoc('note', { title: 'Note' }, 'V1');
    const staleDoc = getWorkspace().docs['note'];
    const staleHash = staleDoc?.hash;
    expect(staleHash).toBeTruthy();

    // Simulate an external edit landing (and the file-watcher picking it up) between load and save.
    const filePath = path.join(getDocsDir(), 'note.md');
    await fs.writeFile(filePath, matter.stringify('V2 (external edit)', { title: 'Note' }), 'utf-8');
    await loadDoc(filePath);

    const res = await fetch(`${baseUrl}/api/docs/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'My edit built on the stale V1', revisionMessage: 'Update note', baseHash: staleHash }),
    });
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.code).toBe('doc-conflict');

    const onDisk = matter(await fs.readFile(filePath, 'utf-8'));
    expect(onDisk.content.trim()).toBe('V2 (external edit)');
  });

  it('docsCommitOnSave off: file is written but no commit is created', async () => {
    getWorkspace().config = { ...getConfig(), docsCommitOnSave: false };
    await writeLocalDoc('note', { title: 'Note' }, 'Original body');
    const baseline = await commitCount(root);

    const res = await fetch(`${baseUrl}/api/docs/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'New body', revisionMessage: 'Update note' }),
    });
    expect(res.status).toBe(200);
    expect(await commitCount(root)).toBe(baseline);

    const onDisk = matter(await fs.readFile(path.join(getDocsDir(), 'note.md'), 'utf-8'));
    expect(onDisk.content.trim()).toBe('New body');
  });

  it('group-doc PUT still routes through submitGroupEdit and creates no local-repo commit', async () => {
    const groupStoreDir = path.join(root, '.flux-group');
    await fs.mkdir(groupStoreDir, { recursive: true });
    const groupFile = path.join(groupStoreDir, 'onboarding.md');
    await fs.writeFile(groupFile, matter.stringify('Group body', { title: 'Onboarding' }), 'utf-8');

    const group: GroupContext = {
      parentRoot: root,
      config: { name: 'acme', members: [] },
      members: [],
      groupStoreDir,
      docsBranch: 'flux-group-docs',
    };
    getWorkspace().groupContext = group;
    await loadGroupDoc(groupStoreDir, groupFile);
    const baseline = await commitCount(root);

    const res = await fetch(`${baseUrl}/api/docs/Product/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Updated group body', revisionMessage: 'Should be ignored for group docs' }),
    });
    expect(res.status).toBe(200);
    expect(await commitCount(root)).toBe(baseline);

    const onDisk = matter(await fs.readFile(groupFile, 'utf-8'));
    expect(onDisk.content.trim()).toBe('Updated group body');

    getWorkspace().groupContext = null;
  });
});
