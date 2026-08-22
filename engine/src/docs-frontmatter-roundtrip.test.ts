// FLUX-1650: docs front matter used to be rewritten as `{ title, order }` only on every save —
// any other key (`sources`, `last_verified`, `publish`, `owner`, …) was silently dropped the
// first time a doc was edited through the viewer/API. These tests cover the full retain-on-load
// / spread-on-save contract: `buildDocFrontmatter`/`buildDocMarkdown` (file-utils.ts), the local
// PUT + reorder + rename-folder route paths, and the group-doc PUT path (routes/docs.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import matter from 'gray-matter';
import { setWorkspaceRoot } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { loadDoc, loadGroupDoc } from './task-store.js';
import { buildDocFrontmatter, buildDocMarkdown, getDocsDir } from './file-utils.js';
import type { GroupContext } from './group.js';

vi.mock('./group-edit.js', () => ({
  // Real `submitGroupEdit` commits + fans out over git (FLUX-396/397) — irrelevant to whether
  // front matter survives. Stand in with the same file-write semantics as the real
  // `applyEditsToStore` (already covered on its own in group-edit.test.ts) and skip the sync.
  submitGroupEdit: vi.fn(async (writer: GroupContext, edits: Array<{ path: string; content?: string; delete?: boolean }>) => {
    const fsMod = await import('fs/promises');
    const pathMod = await import('path');
    for (const edit of edits) {
      const abs = pathMod.join(writer.groupStoreDir, ...edit.path.split('/'));
      if (edit.delete) {
        await fsMod.rm(abs, { force: true });
      } else {
        await fsMod.mkdir(pathMod.dirname(abs), { recursive: true });
        await fsMod.writeFile(abs, edit.content ?? '', 'utf8');
      }
    }
    return { applied: edits.map((e) => e.path), sync: { pushed: [], skipped: [], errors: [] } };
  }),
}));

describe('buildDocFrontmatter / buildDocMarkdown — spread + override order (FLUX-1650)', () => {
  it('spreads retained extras before title/order, and title/order always win', () => {
    // Even a contrived extras object carrying stale title/order keys must lose to the explicit
    // params — real callers never pass such an object (loadDoc/loadGroupDoc destructure title/
    // order out before retaining), but the override must not depend on that.
    const fm = buildDocFrontmatter('Real Title', 7, { title: 'stale', order: 1, sources: ['a', 'b'], publish: true });
    expect(fm).toEqual({ sources: ['a', 'b'], publish: true, title: 'Real Title', order: 7 });
  });

  it('omits order entirely when undefined, same as with no extras', () => {
    const fm = buildDocFrontmatter('T', undefined, { owner: { name: 'Ada' } });
    expect(fm).toEqual({ owner: { name: 'Ada' }, title: 'T' });
    expect('order' in fm).toBe(false);
  });

  it('defaults extras to {} — existing two-arg call sites are unaffected', () => {
    expect(buildDocFrontmatter('T', 3)).toEqual({ title: 'T', order: 3 });
  });

  it('buildDocMarkdown round-trips extras through gray-matter', () => {
    const markdown = buildDocMarkdown('T', 2, 'Body text', { sources: ['x'], nested: { a: 1 } });
    const parsed = matter(markdown);
    expect(parsed.data).toEqual({ sources: ['x'], nested: { a: 1 }, title: 'T', order: 2 });
    expect(parsed.content.trim()).toBe('Body text');
  });
});

describe('docs routes — extra front-matter retention (FLUX-1650)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-docs-frontmatter-'));
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

  it('PUT body edit preserves extra keys (array + nested-object values); title override wins', async () => {
    const filePath = await writeLocalDoc(
      'note',
      { title: 'Note', order: 3, sources: ['https://a', 'https://b'], publish: true, owner: { name: 'Ada', team: 'docs' } },
      'Original body',
    );

    const res = await fetch(`${baseUrl}/api/docs/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed', body: 'New body' }),
    });
    expect(res.status).toBe(200);

    const onDisk = matter(await fs.readFile(filePath, 'utf-8'));
    expect(onDisk.data).toEqual({
      sources: ['https://a', 'https://b'],
      publish: true,
      owner: { name: 'Ada', team: 'docs' },
      title: 'Renamed',
      order: 3,
    });
    expect(onDisk.content.trim()).toBe('New body');
  });

  it('drag-reorder (order-only PUT) preserves extra keys', async () => {
    const filePath = await writeLocalDoc('reorder-me', { title: 'Reorder Me', order: 1, sources: ['s1'] }, 'Body');

    const res = await fetch(`${baseUrl}/api/docs/reorder-me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: 5 }),
    });
    expect(res.status).toBe(200);

    const onDisk = matter(await fs.readFile(filePath, 'utf-8'));
    expect(onDisk.data).toEqual({ sources: ['s1'], title: 'Reorder Me', order: 5 });
  });

  it('load -> save with no field changes is idempotent — extras unchanged', async () => {
    const original = { title: 'Idem', order: 2, sources: ['keep'], publish: false };
    const filePath = await writeLocalDoc('idempotent', original, 'Same body');

    const res = await fetch(`${baseUrl}/api/docs/idempotent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const onDisk = matter(await fs.readFile(filePath, 'utf-8'));
    expect(onDisk.data).toEqual(original);
    expect(onDisk.content.trim()).toBe('Same body');
  });

  it('POST /rename-folder preserves extra keys on every moved doc', async () => {
    await writeLocalDoc('guides/one', { title: 'One', order: 1, sources: ['s1'] }, 'Body one');
    await writeLocalDoc('guides/two', { title: 'Two', last_verified: '2026-01-01' }, 'Body two');

    const res = await fetch(`${baseUrl}/api/docs/rename-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'guides', to: 'guides-renamed' }),
    });
    expect(res.status).toBe(200);

    const oneOnDisk = matter(await fs.readFile(path.join(getDocsDir(), 'guides-renamed', 'one.md'), 'utf-8'));
    expect(oneOnDisk.data).toEqual({ sources: ['s1'], title: 'One', order: 1 });

    const twoOnDisk = matter(await fs.readFile(path.join(getDocsDir(), 'guides-renamed', 'two.md'), 'utf-8'));
    expect(twoOnDisk.data).toEqual({ last_verified: '2026-01-01', title: 'Two' });
  });

  it('group-doc PUT preserves extra keys (routed through submitGroupEdit)', async () => {
    const groupStoreDir = path.join(root, '.flux-group');
    await fs.mkdir(groupStoreDir, { recursive: true });
    const groupFile = path.join(groupStoreDir, 'onboarding.md');
    await fs.writeFile(groupFile, matter.stringify('Group body', { title: 'Onboarding', sources: ['spec.md'] }), 'utf-8');

    const group: GroupContext = {
      parentRoot: root,
      config: { name: 'acme', members: [] },
      members: [],
      groupStoreDir,
      docsBranch: 'flux-group-docs',
    };
    getWorkspace().groupContext = group;
    await loadGroupDoc(groupStoreDir, groupFile);

    const res = await fetch(`${baseUrl}/api/docs/Product/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Updated group body' }),
    });
    expect(res.status).toBe(200);

    const onDisk = matter(await fs.readFile(groupFile, 'utf-8'));
    expect(onDisk.data).toEqual({ sources: ['spec.md'], title: 'Onboarding' });
    expect(onDisk.content.trim()).toBe('Updated group body');

    getWorkspace().groupContext = null;
  });
});
