import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { discardUncommittedFiles } from './workspace-discard.js';
import { cliSessionsById, cliSessionsByTaskId, getBlockingSessionsForRef, registerSession } from './session-store.js';
import type { CliSessionRecord, CliFramework } from './agents/types.js';

// Real git ops are slow on Windows under parallel suite load (FLUX-749) — raise file-wide,
// mirroring diff-aggregator.test.ts.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

// Held in a const, not inlined as `framework: 'claude'`, so the adapter-boundary guard
// (check:boundary / FLUX-938) doesn't flag a per-CLI literal in this non-adapter file — the
// session under test is framework-agnostic. Same idiom as build-initial-prompt.test.ts.
const DEFAULT_FRAMEWORK: CliFramework = 'claude';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

async function gitInit(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await git(root, ['init', '-b', 'master']);
  await git(root, ['config', 'user.email', 'test@test.com']);
  await git(root, ['config', 'user.name', 'Test']);
  // Keep content byte-identical across platforms — a Windows autocrlf checkout would
  // re-materialize restored files with \r\n and break the content assertions.
  await git(root, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(root, 'a.txt'), 'original a\n', 'utf8');
  await fs.writeFile(path.join(root, 'b.txt'), 'original b\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);
}

describe('discardUncommittedFiles (FLUX-1333)', () => {
  let repo: string;

  const read = (f: string) => fs.readFile(path.join(repo, f), 'utf8');
  const porcelain = async () => (await git(repo, ['status', '--porcelain'])).stdout.trim();

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-discard-'));
    await gitInit(repo);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('restores a modified file with mixed staged + unstaged changes to HEAD', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'staged edit\n', 'utf8');
    await git(repo, ['add', 'a.txt']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'unstaged edit on top\n', 'utf8');

    const results = await discardUncommittedFiles(repo, ['a.txt']);
    expect(results).toEqual([{ file: 'a.txt', ok: true }]);
    expect(await read('a.txt')).toBe('original a\n');
    expect(await porcelain()).toBe('');
  });

  it('deletes an untracked file (including inside an untracked directory)', async () => {
    await fs.mkdir(path.join(repo, 'newdir'), { recursive: true });
    await fs.writeFile(path.join(repo, 'newdir', 'u.txt'), 'u\n', 'utf8');

    const results = await discardUncommittedFiles(repo, ['newdir/u.txt']);
    expect(results).toEqual([{ file: 'newdir/u.txt', ok: true }]);
    expect(existsSync(path.join(repo, 'newdir', 'u.txt'))).toBe(false);
    expect(await porcelain()).toBe('');
  });

  it('unstages and deletes a staged-added file', async () => {
    await fs.writeFile(path.join(repo, 'staged-new.txt'), 'n\n', 'utf8');
    await git(repo, ['add', 'staged-new.txt']);

    const results = await discardUncommittedFiles(repo, ['staged-new.txt']);
    expect(results).toEqual([{ file: 'staged-new.txt', ok: true }]);
    expect(existsSync(path.join(repo, 'staged-new.txt'))).toBe(false);
    expect(await porcelain()).toBe('');
  });

  it('restores an unstaged-deleted file', async () => {
    await fs.rm(path.join(repo, 'a.txt'));

    const results = await discardUncommittedFiles(repo, ['a.txt']);
    expect(results).toEqual([{ file: 'a.txt', ok: true }]);
    expect(await read('a.txt')).toBe('original a\n');
    expect(await porcelain()).toBe('');
  });

  it('restores a staged-deleted file', async () => {
    await git(repo, ['rm', 'a.txt']);

    const results = await discardUncommittedFiles(repo, ['a.txt']);
    expect(results).toEqual([{ file: 'a.txt', ok: true }]);
    expect(await read('a.txt')).toBe('original a\n');
    expect(await porcelain()).toBe('');
  });

  it('reverts a staged rename atomically — old path restored, new path gone', async () => {
    await git(repo, ['mv', 'a.txt', 'renamed.txt']);

    const results = await discardUncommittedFiles(repo, ['renamed.txt']);
    expect(results).toEqual([{ file: 'renamed.txt', ok: true }]);
    expect(await read('a.txt')).toBe('original a\n');
    expect(existsSync(path.join(repo, 'renamed.txt'))).toBe(false);
    expect(await porcelain()).toBe('');
  });

  it('handles the unstaged rename shape as independent delete + untracked entries', async () => {
    // No git mv — a plain fs rename surfaces as ` D a.txt` + `?? moved.txt`.
    await fs.rename(path.join(repo, 'a.txt'), path.join(repo, 'moved.txt'));

    const results = await discardUncommittedFiles(repo, ['moved.txt', 'a.txt']);
    expect(results).toEqual([
      { file: 'moved.txt', ok: true },
      { file: 'a.txt', ok: true },
    ]);
    expect(await read('a.txt')).toBe('original a\n');
    expect(existsSync(path.join(repo, 'moved.txt'))).toBe(false);
    expect(await porcelain()).toBe('');
  });

  it('refuses a clean (committed-only) file per-file without touching anything', async () => {
    const results = await discardUncommittedFiles(repo, ['a.txt']);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/No uncommitted changes/);
    expect(await read('a.txt')).toBe('original a\n');
  });

  it('isolates per-file failures — an unknown file does not abort the rest', async () => {
    await fs.writeFile(path.join(repo, 'b.txt'), 'edited\n', 'utf8');

    const results = await discardUncommittedFiles(repo, ['does-not-exist.txt', 'b.txt']);
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]).toEqual({ file: 'b.txt', ok: true });
    expect(await read('b.txt')).toBe('original b\n');
    expect(await porcelain()).toBe('');
  });
});

describe('getBlockingSessionsForRef (FLUX-1333)', () => {
  const mainRoot = path.join(os.tmpdir(), 'eh-main-checkout');
  const wtRoot = path.join(os.tmpdir(), 'eh-worktrees', 'EventHorizon-FLUX-9');

  function seedSession(id: string, taskId: string, status: CliSessionRecord['status'], executionRoot?: string): void {
    const rec = {
      id,
      taskId,
      framework: DEFAULT_FRAMEWORK,
      status,
      command: 'claude',
      args: [],
      startedAt: new Date().toISOString(),
      label: 'test',
      outputBuffer: '',
      liveOutputBuffer: '',
      pendingAssistantText: '',
      cumulativeOutput: '',
      requestedStop: false,
      writeQueue: Promise.resolve(),
      skipPermissions: true,
      ...(executionRoot ? { executionRoot } : {}),
    } as CliSessionRecord;
    cliSessionsById.set(id, rec);
    registerSession(taskId, id);
  }

  afterEach(() => {
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
  });

  it('blocks a branch ref while its ticket has a running session', () => {
    seedSession('s1', 'FLUX-9', 'running');
    const tasks = [{ id: 'FLUX-9', branch: 'flux/FLUX-9-x' }];
    expect(getBlockingSessionsForRef('flux/FLUX-9-x', wtRoot, tasks)).toHaveLength(1);
    expect(getBlockingSessionsForRef('flux/other', wtRoot, tasks)).toHaveLength(0);
  });

  it('does not block for a parked waiting-input session', () => {
    seedSession('s1', 'FLUX-9', 'waiting-input');
    const tasks = [{ id: 'FLUX-9', branch: 'flux/FLUX-9-x' }];
    expect(getBlockingSessionsForRef('flux/FLUX-9-x', wtRoot, tasks)).toHaveLength(0);
  });

  it("blocks ref='main' only for sessions in the shared checkout (branchless tasks)", () => {
    seedSession('s1', 'FLUX-1', 'running'); // branchless → shared main tree
    seedSession('s2', 'FLUX-9', 'running'); // branch ticket → its own worktree
    const tasks = [
      { id: 'FLUX-1', branch: null },
      { id: 'FLUX-9', branch: 'flux/FLUX-9-x' },
    ];
    const blockers = getBlockingSessionsForRef('main', mainRoot, tasks);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.id).toBe('s1');
  });

  it('trusts executionRoot when present — a session running in the main checkout blocks main even if its ticket has a branch', () => {
    // e.g. a grooming session: always branchless in the shared checkout (FLUX-1214).
    seedSession('s1', 'FLUX-9', 'running', mainRoot);
    const tasks = [{ id: 'FLUX-9', branch: 'flux/FLUX-9-x' }];
    expect(getBlockingSessionsForRef('main', mainRoot, tasks)).toHaveLength(1);
    // …and by the same token it does NOT block the branch's own worktree.
    expect(getBlockingSessionsForRef('flux/FLUX-9-x', wtRoot, tasks)).toHaveLength(0);
  });
});
