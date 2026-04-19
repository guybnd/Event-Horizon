import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { applyEditsToStore } from './group-edit.js';

let storeDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-group-edit-'));
  storeDir = path.join(root, '.flux-group');
  await fs.mkdir(path.join(storeDir, 'features'), { recursive: true });
  await fs.writeFile(path.join(storeDir, 'index.md'), '# idx\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(path.dirname(storeDir), { recursive: true, force: true });
});

describe('applyEditsToStore — path safety', () => {
  it('rejects absolute paths', async () => {
    await expect(
      applyEditsToStore(storeDir, [{ path: path.join(os.tmpdir(), 'evil.md'), content: 'x' }]),
    ).rejects.toThrow(/relative/i);
  });

  it('rejects `..` traversal that escapes the store', async () => {
    await expect(
      applyEditsToStore(storeDir, [{ path: '../../escape.md', content: 'x' }]),
    ).rejects.toThrow(/escapes the group store/i);
  });

  it('rejects writes into the worktree .git dir', async () => {
    await expect(
      applyEditsToStore(storeDir, [{ path: '.git/hooks/post-commit', content: 'x' }]),
    ).rejects.toThrow(/git dir/i);
  });

  it('aborts the whole batch before any write when one path is bad', async () => {
    await expect(
      applyEditsToStore(storeDir, [
        { path: 'features/good.md', content: 'good' },
        { path: '../escape.md', content: 'bad' },
      ]),
    ).rejects.toThrow();
    // The good file must NOT have been written — validation is up-front.
    expect(existsSync(path.join(storeDir, 'features', 'good.md'))).toBe(false);
  });
});

describe('applyEditsToStore — apply', () => {
  it('creates a new nested file (mkdir -p)', async () => {
    const applied = await applyEditsToStore(storeDir, [
      { path: 'features/auth.md', content: '# auth\n' },
    ]);
    expect(applied).toEqual(['features/auth.md']);
    expect(await fs.readFile(path.join(storeDir, 'features', 'auth.md'), 'utf8')).toBe('# auth\n');
  });

  it('updates an existing file', async () => {
    const applied = await applyEditsToStore(storeDir, [{ path: 'index.md', content: '# new\n' }]);
    expect(applied).toEqual(['index.md']);
    expect(await fs.readFile(path.join(storeDir, 'index.md'), 'utf8')).toBe('# new\n');
  });

  it('deletes a file', async () => {
    const applied = await applyEditsToStore(storeDir, [{ path: 'index.md', delete: true }]);
    expect(applied).toEqual(['index.md']);
    expect(existsSync(path.join(storeDir, 'index.md'))).toBe(false);
  });

  it('normalizes returned paths to forward slashes', async () => {
    const applied = await applyEditsToStore(storeDir, [
      { path: 'features/x/y.md', content: 'z' },
    ]);
    expect(applied).toEqual(['features/x/y.md']);
  });

  it('requires string content for a non-delete edit', async () => {
    await expect(
      applyEditsToStore(storeDir, [{ path: 'index.md' } as any]),
    ).rejects.toThrow(/string content/i);
  });

  it('rejects an empty edit batch', async () => {
    await expect(applyEditsToStore(storeDir, [])).rejects.toThrow(/at least one edit/i);
  });
});
