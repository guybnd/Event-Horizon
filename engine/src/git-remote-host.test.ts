// FLUX-1403: resolveRemoteHost() is routed through runGit() (git-exec.ts), not a bare
// execFile — mock git-exec's runGit directly rather than child_process, mirroring
// branch-manager-pr-cwd.test.ts's approach for other runGit()-routed modules.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const runGitMock = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGit: (...args: unknown[]) => runGitMock(...args),
}));

import { resolveRemoteHost, invalidateRemoteHostCache } from './git-remote-host.js';

describe('resolveRemoteHost (FLUX-987)', () => {
  beforeEach(() => {
    runGitMock.mockReset();
    invalidateRemoteHostCache();
  });

  it('extracts the hostname from an https origin URL', async () => {
    runGitMock.mockResolvedValue({ stdout: 'https://github.com/acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('github.com');
  });

  it('extracts the hostname from a non-github https origin URL', async () => {
    runGitMock.mockResolvedValue({ stdout: 'https://gitlab.example.com/acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('gitlab.example.com');
  });

  it('extracts the hostname from an scp-like ssh origin URL', async () => {
    runGitMock.mockResolvedValue({ stdout: 'git@github.com:acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('github.com');
  });

  it('extracts the hostname from an ssh:// origin URL', async () => {
    runGitMock.mockResolvedValue({ stdout: 'ssh://git@bitbucket.example.com:2222/acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('bitbucket.example.com');
  });

  it('resolves to null when there is no origin remote / the git call fails', async () => {
    runGitMock.mockRejectedValue(new Error('fatal: No such remote \'origin\''));
    expect(await resolveRemoteHost('/repo')).toBeNull();
  });

  it('caches the result per cwd until invalidated', async () => {
    runGitMock.mockResolvedValue({ stdout: 'https://github.com/acme/widgets.git\n', stderr: '' });
    await resolveRemoteHost('/repo');
    await resolveRemoteHost('/repo');
    expect(runGitMock).toHaveBeenCalledTimes(1);
    invalidateRemoteHostCache();
    await resolveRemoteHost('/repo');
    expect(runGitMock).toHaveBeenCalledTimes(2);
  });

  it('resolves each distinct cwd independently', async () => {
    runGitMock.mockImplementation((_args: string[], opts: { cwd?: string }) =>
      Promise.resolve({ stdout: opts.cwd === '/repo-a' ? 'https://github.com/a/a.git' : 'https://gitlab.example.com/b/b.git', stderr: '' }));
    expect(await resolveRemoteHost('/repo-a')).toBe('github.com');
    expect(await resolveRemoteHost('/repo-b')).toBe('gitlab.example.com');
  });

  // FLUX-1403: resolveRemoteHost's runGit() call MUST pass an explicit `env` override (bypassing
  // buildGitSyncEnv()) — buildGitSyncEnv() calls resolveRemoteHost() itself, so leaving this on
  // the default env-building path recurses infinitely. See git-sync-env-recursion.test.ts for the
  // real (unmocked) regression test of the full recursion chain.
  it('passes env:process.env (not the default buildGitSyncEnv path) to runGit', async () => {
    runGitMock.mockResolvedValue({ stdout: 'https://github.com/acme/widgets.git\n', stderr: '' });
    await resolveRemoteHost('/repo');
    expect(runGitMock).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: '/repo', env: process.env }),
    );
  });
});
