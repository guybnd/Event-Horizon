import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { resolveMainWorktree } from './mcp-server.js';

/**
 * FLUX-571: a linked git worktree must resolve to the main working tree so the MCP server
 * binds to the real ticket store, not the worktree's empty one. These tests fabricate the
 * git layout on disk (no real git needed) to exercise the pure-filesystem parse.
 */
describe('resolveMainWorktree', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'eh-wt-')));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves a linked worktree (.git file + commondir) to the main tree', async () => {
    const main = path.join(tmp, 'EventHorizon');
    const wtBase = path.join(tmp, '.eh-worktrees');
    const wt = path.join(wtBase, 'EventHorizon-FLUX-345');
    const gitdir = path.join(main, '.git', 'worktrees', 'EventHorizon-FLUX-345');
    await fs.mkdir(gitdir, { recursive: true });
    await fs.mkdir(wt, { recursive: true });
    // commondir points back to the common .git (relative, as real git writes it).
    await fs.writeFile(path.join(gitdir, 'commondir'), '../..\n');
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${gitdir.replace(/\\/g, '/')}\n`);

    expect(resolveMainWorktree(wt)).toBe(path.resolve(main));
  });

  it('falls back to stripping /worktrees/<name> when commondir is absent', async () => {
    const main = path.join(tmp, 'repo');
    const wt = path.join(tmp, 'wt');
    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    await fs.mkdir(gitdir, { recursive: true });
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${gitdir.replace(/\\/g, '/')}\n`);

    expect(resolveMainWorktree(wt)).toBe(path.resolve(main));
  });

  it('returns null for a normal repo (.git is a directory)', async () => {
    const repo = path.join(tmp, 'normal');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    expect(resolveMainWorktree(repo)).toBeNull();
  });

  it('returns null when there is no .git at all', async () => {
    const dir = path.join(tmp, 'plain');
    await fs.mkdir(dir, { recursive: true });
    expect(resolveMainWorktree(dir)).toBeNull();
  });
});
