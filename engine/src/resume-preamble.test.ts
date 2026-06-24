import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Top-level mocks (Vitest hoists these) ───────────────────────────────────
// FLUX-716 (item 5): stub the two git-backed deps so sections 1 (branch ahead/behind) and 2
// (master-side file delta) can be exercised without a live repo. `task-store` is deliberately NOT
// mocked — the cache-driven tests below use the real `tasksCache`. The existing no-branch tests
// never call `getTicketBranchStatus`/`changedFilesMasterSideOfBranch`, so these mocks don't affect
// them (`getDefaultBranch` is called but its result is only used to label the branch-scoped lines).
vi.mock('./branch-manager.js', () => ({
  getDefaultBranch: vi.fn(async () => 'main'),
  getTicketBranchStatus: vi.fn(async () => ({ exists: false, aheadCount: 0, behindCount: 0 })),
}));
vi.mock('./diff-aggregator.js', () => ({
  changedFilesMasterSideOfBranch: vi.fn(async () => []),
}));

import { buildResumePreamble } from './resume-preamble.js';
import { tasksCache } from './task-store.js';
import { getDefaultBranch, getTicketBranchStatus } from './branch-manager.js';
import { changedFilesMasterSideOfBranch } from './diff-aggregator.js';

/**
 * FLUX-655: the resume preamble assembler. The cache-driven tests exercise the pure, side-effect-free
 * parts: the "no delta ⇒ null" contract, the terminal/merged sibling-ticket scan over `tasksCache`,
 * the bound-ticket exclusion, and the size cap (these pass no `branch`, so only the cache section
 * runs). FLUX-716 adds direct coverage for the two git-backed sections via the mocks above.
 */

const ROOT = '/tmp/eh-resume-preamble-test';

/** A `ChangedFile`-shaped stub for `changedFilesMasterSideOfBranch`. */
function changed(file: string) {
  return { file, additions: 1, deletions: 0, status: 'modified' as const };
}

function statusChange(to: string, date: string) {
  return { type: 'status_change', from: 'In Progress', to, user: 'Agent', date };
}

describe('buildResumePreamble', () => {
  const seeded: string[] = [];

  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    seeded.length = 0;
    // Reset git mocks to their "nothing moved" defaults so each test sets only what it exercises.
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: false, aheadCount: 0, behindCount: 0 });
    vi.mocked(changedFilesMasterSideOfBranch).mockResolvedValue([]);
  });

  afterEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  });

  function seed(id: string, task: any) {
    tasksCache[id] = { id, ...task };
    seeded.push(id);
  }

  it('returns null when nothing moved (no branch, empty cache)', async () => {
    expect(await buildResumePreamble({ workspaceRoot: ROOT, sinceIso: '2026-06-20T00:00:00.000Z' })).toBeNull();
  });

  it('returns null when no sinceIso is provided (no basis for movement)', async () => {
    seed('FLUX-2', { history: [statusChange('Done', '2026-06-22T00:00:00.000Z')] });
    expect(await buildResumePreamble({ workspaceRoot: ROOT })).toBeNull();
  });

  it('lists sibling tickets that reached a terminal status after sinceIso', async () => {
    seed('FLUX-2', { history: [statusChange('Done', '2026-06-22T12:00:00.000Z')] });
    seed('FLUX-3', { history: [statusChange('Released', '2026-06-22T13:00:00.000Z')] });
    const out = await buildResumePreamble({ workspaceRoot: ROOT, sinceIso: '2026-06-22T00:00:00.000Z' });
    expect(out).toBeTruthy();
    expect(out).toContain('FLUX-2 (Done)');
    expect(out).toContain('FLUX-3 (Released)');
    expect(out).toContain('situational-update');
  });

  it('ignores moves that predate sinceIso and non-terminal moves', async () => {
    seed('FLUX-2', { history: [statusChange('Done', '2026-06-19T00:00:00.000Z')] }); // before
    seed('FLUX-3', { history: [statusChange('Ready', '2026-06-22T00:00:00.000Z')] }); // not terminal
    expect(await buildResumePreamble({ workspaceRoot: ROOT, sinceIso: '2026-06-20T00:00:00.000Z' })).toBeNull();
  });

  it('excludes the chat\'s own bound ticket from the movement scan', async () => {
    seed('FLUX-655', { history: [statusChange('Done', '2026-06-22T12:00:00.000Z')] });
    expect(
      await buildResumePreamble({ taskId: 'FLUX-655', workspaceRoot: ROOT, sinceIso: '2026-06-20T00:00:00.000Z' }),
    ).toBeNull();
  });

  it('caps the ticket list with a "+N more" tail', async () => {
    for (let i = 1; i <= 10; i++) {
      seed(`FLUX-${100 + i}`, { history: [statusChange('Done', '2026-06-22T12:00:00.000Z')] });
    }
    const out = await buildResumePreamble({ workspaceRoot: ROOT, sinceIso: '2026-06-20T00:00:00.000Z' });
    expect(out).toContain('+4 more'); // 10 moved, MAX_TICKETS = 6
  });
});

/**
 * FLUX-716 (item 5): direct coverage for the two git-backed sections via the mocked branch-manager +
 * diff-aggregator. These pass a `branch` so sections 1 & 2 run; the empty `tasksCache` keeps section
 * 3 silent.
 */
describe('buildResumePreamble — git-backed sections (mocked)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: false, aheadCount: 0, behindCount: 0 });
    vi.mocked(changedFilesMasterSideOfBranch).mockResolvedValue([]);
  });

  afterEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  });

  it('section 1: renders the branch ahead/behind line with the resolved default-branch label', async () => {
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 2, behindCount: 3 });
    const out = await buildResumePreamble({ branch: 'flux/x', workspaceRoot: ROOT });
    expect(out).toBeTruthy();
    expect(out).toContain('Branch `flux/x` is 3 behind / 2 ahead of main.');
    // The pre-resolved default branch is passed through to getTicketBranchStatus (item 1).
    expect(vi.mocked(getTicketBranchStatus)).toHaveBeenCalledWith('flux/x', 'main');
  });

  it('section 1: renders behind-only and ahead-only correctly', async () => {
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 0, behindCount: 5 });
    const behind = await buildResumePreamble({ branch: 'flux/x', workspaceRoot: ROOT });
    expect(behind).toContain('is 5 behind of main.');

    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 4, behindCount: 0 });
    const ahead = await buildResumePreamble({ branch: 'flux/x', workspaceRoot: ROOT });
    expect(ahead).toContain('is 4 ahead of main.');
  });

  it('section 1: no line when the branch is level (0 ahead / 0 behind)', async () => {
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 0, behindCount: 0 });
    expect(await buildResumePreamble({ branch: 'flux/x', workspaceRoot: ROOT })).toBeNull();
  });

  it('section 2: renders the master-side file delta with the default-branch label', async () => {
    vi.mocked(changedFilesMasterSideOfBranch).mockResolvedValue([changed('a.ts'), changed('b.ts')]);
    const out = await buildResumePreamble({ branch: 'flux/x', workspaceRoot: ROOT });
    expect(out).toBeTruthy();
    expect(out).toContain('main changed underneath you: a.ts, b.ts');
  });

  it('section 2: caps the file list at MAX_FILES (8) with a "+N more" tail', async () => {
    const files = Array.from({ length: 11 }, (_, i) => changed(`file-${i}.ts`));
    vi.mocked(changedFilesMasterSideOfBranch).mockResolvedValue(files);
    const out = await buildResumePreamble({ branch: 'flux/x', workspaceRoot: ROOT });
    expect(out).toContain('file-0.ts');
    expect(out).toContain('file-7.ts');
    expect(out).not.toContain('file-8.ts');
    expect(out).toContain('(+3 more)'); // 11 files, MAX_FILES = 8
  });

  it('item 4: neutralizes backticks in interpolated names so the fence cannot be broken', async () => {
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 1, behindCount: 0 });
    vi.mocked(changedFilesMasterSideOfBranch).mockResolvedValue([changed('e`vil```.ts')]);
    const out = await buildResumePreamble({ branch: 'flux/```x', workspaceRoot: ROOT });
    expect(out).toBeTruthy();
    // Exactly two ``` runs survive — the opening (```situational-update) and closing fence. Any
    // backtick from an interpolated name would add a third run and break out of the block.
    expect(out!.match(/```/g)?.length).toBe(2);
    expect(out).toContain('situational-update');
    expect(out).not.toContain('```x'); // the branch-name fence run was collapsed
    expect(out).not.toContain('e`vil'); // the file-name backticks were collapsed
  });
});
