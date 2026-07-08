import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setWorkspaceRoot } from './workspace.js';

// FLUX-1276 — every `gh` (and `git`) spawn in the PR flow (pr view/create/edit/merge/review) used
// to run WITHOUT a cwd, inheriting the engine PROCESS cwd instead of the bound workspace root. Dev
// never reproduced it (`npm run dev` runs from the repo root by accident); a packaged install
// launched from anywhere hit `fatal: not a git repository` on every finish/Ready PR call. Mock
// git-exec (forwarding opts, unlike the other branch-manager mocks, so cwd is assertable) and
// confirm the workspace root is always passed as cwd, an unbound workspace fails fast with the
// FLUX-705 actionable error, and a genuine "not a repo" failure names the path.
const runGh = vi.fn();
const runGit = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGh: (args: string[], opts?: unknown) => runGh(args, opts),
  runGit: (args: string[], opts?: unknown) => runGit(args, opts),
}));

const { createPullRequest, mergePullRequest } = await import('./branch-manager.js');

const WORKSPACE = 'C:\\fake\\workspace';

beforeEach(() => {
  runGh.mockReset();
  runGit.mockReset();
  runGit.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('PR-flow gh/git cwd (FLUX-1276)', () => {
  it('createPullRequest pushes and creates the PR with the workspace root as cwd', async () => {
    setWorkspaceRoot(WORKSPACE);
    runGh
      .mockRejectedValueOnce(new Error('no pull requests found')) // pr view
      .mockResolvedValueOnce({ stdout: 'https://github.com/o/r/pull/1\n', stderr: '' }); // pr create

    const url = await createPullRequest('flux/FLUX-1276-fix', 'title', 'body');

    expect(url).toBe('https://github.com/o/r/pull/1');
    expect(runGit).toHaveBeenCalledWith(['push', '-u', 'origin', 'flux/FLUX-1276-fix'], { cwd: WORKSPACE });
    expect(runGh).toHaveBeenNthCalledWith(1, ['pr', 'view', 'flux/FLUX-1276-fix', '--json', 'url,state,title,body'], { cwd: WORKSPACE });
    expect(runGh).toHaveBeenNthCalledWith(2, ['pr', 'create', '--title', 'title', '--body', 'body', '--head', 'flux/FLUX-1276-fix'], { cwd: WORKSPACE });
  });

  it('mergePullRequest merges the PR with the workspace root as cwd', async () => {
    setWorkspaceRoot(WORKSPACE);
    runGh.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await mergePullRequest('flux/FLUX-1276-fix');

    expect(runGh).toHaveBeenCalledWith(['pr', 'merge', 'flux/FLUX-1276-fix', '--squash'], { cwd: WORKSPACE });
  });

  it('throws the FLUX-705 actionable error (not a raw spawn) when no workspace is bound', async () => {
    setWorkspaceRoot(null as unknown as string);

    await expect(mergePullRequest('flux/FLUX-1276-fix')).rejects.toThrow(/No active Event Horizon workspace is bound/);
    expect(runGh).not.toHaveBeenCalled();
  });

  it('reworks a raw "not a git repository" failure into a message naming the workspace path', async () => {
    setWorkspaceRoot(WORKSPACE);
    const raw = new Error('Command failed: git rev-parse HEAD\nfatal: not a git repository (or any of the parent directories): .git') as Error & { stderr?: string };
    raw.stderr = 'fatal: not a git repository (or any of the parent directories): .git';
    runGh.mockRejectedValueOnce(raw);

    await expect(mergePullRequest('flux/FLUX-1276-fix')).rejects.toThrow(
      new RegExp(`workspace root .*${WORKSPACE.replace(/\\/g, '\\\\')}.* is not a git repository`),
    );
  });
});
