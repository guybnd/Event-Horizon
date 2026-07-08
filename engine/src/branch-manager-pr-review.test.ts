import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setWorkspaceRoot } from './workspace.js';

// FLUX-1033 — postPrReview mirrors an internal verdict onto the real GitHub PR, falling back to a
// plain `--comment` review when GitHub rejects a self-review (the Furnace opens the PR under the
// same token). Mock git-exec so no real `gh` is spawned; assert the exact gh argv + fallback.
const runGh = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGh: (args: string[]) => runGh(args),
  runGit: vi.fn(),
}));

// Imported after the mock is registered.
const { postPrReview } = await import('./branch-manager.js');

beforeEach(() => {
  runGh.mockReset();
  // FLUX-1276: postPrReview's runGh calls now route through branch-manager's gh() wrapper, which
  // resolves cwd via requireWorkspaceRoot() — an unbound workspace throws before ever reaching gh.
  setWorkspaceRoot('/tmp/fake-repo');
});

describe('postPrReview (FLUX-1033)', () => {
  it('posts a formal --approve when the reviewer is allowed to (distinct token)', async () => {
    runGh.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const outcome = await postPrReview('https://github.com/o/r/pull/7', 'approved', 'looks good');
    expect(outcome).toBe('approved');
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh).toHaveBeenCalledWith(['pr', 'review', 'https://github.com/o/r/pull/7', '--approve', '--body', 'looks good']);
  });

  it('posts a formal --request-changes for a changes-requested verdict', async () => {
    runGh.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const outcome = await postPrReview('7', 'changes-requested', 'fix it');
    expect(outcome).toBe('changes-requested');
    expect(runGh).toHaveBeenCalledWith(['pr', 'review', '7', '--request-changes', '--body', 'fix it']);
  });

  it('falls back to a --comment review when the formal review is rejected (self-approval)', async () => {
    runGh
      .mockRejectedValueOnce(new Error('GraphQL: Can not approve your own pull request'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const outcome = await postPrReview('7', 'approved', 'lgtm');
    expect(outcome).toBe('commented');
    expect(runGh).toHaveBeenNthCalledWith(1, ['pr', 'review', '7', '--approve', '--body', 'lgtm']);
    expect(runGh).toHaveBeenNthCalledWith(2, ['pr', 'review', '7', '--comment', '--body', 'lgtm']);
  });

  it('returns "failed" (never throws) when both the formal review and the comment fallback fail', async () => {
    runGh
      .mockRejectedValueOnce(new Error('self-approval'))
      .mockRejectedValueOnce(new Error('gh unavailable'));
    const outcome = await postPrReview('7', 'changes-requested', 'x');
    expect(outcome).toBe('failed');
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it('commentOnly posts a `--comment` review and NEVER attempts the formal decision (grouped non-final member)', async () => {
    runGh.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const outcome = await postPrReview('7', 'approved', 'member approved', { commentOnly: true });
    expect(outcome).toBe('commented');
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh).toHaveBeenCalledWith(['pr', 'review', '7', '--comment', '--body', 'member approved']);
  });
});
