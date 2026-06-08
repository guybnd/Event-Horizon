import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  planDocsPromotion,
  collectPromotions,
  applyDocsPromotion,
} from './group-promote.js';
import type { GitRunner } from './group-sync.js';
import type { GroupContext } from './group.js';

let parentRoot: string;

beforeEach(async () => {
  parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-group-promote-'));
  // A repo-local docs tree with a nested file.
  await fs.mkdir(path.join(parentRoot, '.docs', 'architecture'), { recursive: true });
  await fs.writeFile(path.join(parentRoot, '.docs', 'overview.md'), '# overview\n', 'utf8');
  await fs.writeFile(path.join(parentRoot, '.docs', 'architecture', 'payments.md'), '# payments\n', 'utf8');
  // The canonical store scaffold.
  await fs.mkdir(path.join(parentRoot, '.flux-group', 'features'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(parentRoot, { recursive: true, force: true });
});

describe('planDocsPromotion', () => {
  it('walks .docs/ and proposes a features/ target per file (no mutation)', async () => {
    const plan = await planDocsPromotion(parentRoot);
    expect(plan.parentRoot).toBe(parentRoot);
    expect(plan.candidates).toEqual([
      { source: '.docs/architecture/payments.md', target: 'features/payments.md' },
      { source: '.docs/overview.md', target: 'features/overview.md' },
    ]);
    // Pure discovery — the source files are untouched.
    expect(existsSync(path.join(parentRoot, '.docs', 'overview.md'))).toBe(true);
  });

  it('returns no candidates when there is no .docs/', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-no-docs-'));
    try {
      const plan = await planDocsPromotion(empty);
      expect(plan.candidates).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('collectPromotions — validation', () => {
  it('rejects a target that escapes the store', async () => {
    await expect(
      collectPromotions(parentRoot, [{ source: '.docs/overview.md', target: '../escape.md' }]),
    ).rejects.toThrow(/escapes the group store/i);
  });

  it('rejects a target that writes into the worktree .git dir', async () => {
    await expect(
      collectPromotions(parentRoot, [{ source: '.docs/overview.md', target: '.git/hooks/x' }]),
    ).rejects.toThrow(/git dir/i);
  });

  it('rejects a source that escapes .docs/', async () => {
    await expect(
      collectPromotions(parentRoot, [{ source: '../secret.md', target: 'features/x.md' }]),
    ).rejects.toThrow(/escapes the .docs directory/i);
  });

  it('rejects a missing source', async () => {
    await expect(
      collectPromotions(parentRoot, [{ source: '.docs/nope.md', target: 'features/x.md' }]),
    ).rejects.toThrow(/does not exist/i);
  });

  it('rejects an empty selection batch', async () => {
    await expect(collectPromotions(parentRoot, [])).rejects.toThrow(/at least one selection/i);
  });

  it('reads content and normalizes paths', async () => {
    const collected = await collectPromotions(parentRoot, [
      { source: '.docs/architecture/payments.md', target: 'features/payments.md' },
    ]);
    expect(collected).toEqual([
      { source: '.docs/architecture/payments.md', target: 'features/payments.md', content: '# payments\n' },
    ]);
  });
});

describe('applyDocsPromotion — move semantics', () => {
  function fakeGit(): { runner: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: GitRunner = async (_cwd, args) => {
      calls.push(args);
      // `git rm` actually deletes the file so the move is observable in tests.
      if (args[0] === 'rm') {
        const target = args[args.length - 1];
        await fs.rm(path.join(parentRoot, target), { force: true });
      }
      // syncGroup promotes `.flux-group` to a worktree by re-creating the dir;
      // the real git would create it, so the fake does too.
      if (args[0] === 'worktree' && args[1] === 'add') {
        await fs.mkdir(args[args.length - 1], { recursive: true });
      }
      // Report a dirty tree so the commit path runs.
      if (args[0] === 'status') return { stdout: ' D .docs/overview.md\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    return { runner, calls };
  }

  function group(): GroupContext {
    return { parentRoot, name: 'g', members: [] } as unknown as GroupContext;
  }

  it('writes into the store, removes the source from main, and fans out', async () => {
    const { runner, calls } = fakeGit();
    const result = await applyDocsPromotion(
      group(),
      [{ source: '.docs/architecture/payments.md', target: 'features/payments.md' }],
      { gitRunner: runner },
    );

    // Written into the canonical store.
    expect(await fs.readFile(path.join(parentRoot, '.flux-group', 'features', 'payments.md'), 'utf8')).toBe('# payments\n');
    // Removed from main (the fake `git rm` deleted it).
    expect(existsSync(path.join(parentRoot, '.docs', 'architecture', 'payments.md'))).toBe(false);
    // git rm was issued for the source.
    expect(calls.some((c) => c[0] === 'rm' && c[c.length - 1].includes('payments.md'))).toBe(true);
    expect(result.promoted).toEqual(['features/payments.md']);
    expect(result.failed).toEqual([]);
    expect(result.sync).toBeDefined();
  });
});
