// Mirrors storage-sync-background-pull.test.ts's approach: mock `child_process.execFile` at the
// `util.promisify.custom` symbol so resolveRemoteHost's `promisify(execFile)` call resolves
// deterministically without a real git repo/remote.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { execFileImpl } = vi.hoisted(() => ({ execFileImpl: vi.fn() }));

vi.mock('child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  function execFile(): void {
    throw new Error('execFile invoked directly (non-promisified) — unsupported in this mock');
  }
  type PromisifiedExecFile = typeof execFile & {
    [key: symbol]: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
  };
  (execFile as PromisifiedExecFile)[custom] = (file: string, args: string[], options: Record<string, unknown>) => execFileImpl(file, args, options);
  return { execFile };
});

import { resolveRemoteHost, invalidateRemoteHostCache } from './git-remote-host.js';

describe('resolveRemoteHost (FLUX-987)', () => {
  beforeEach(() => {
    execFileImpl.mockReset();
    invalidateRemoteHostCache();
  });

  it('extracts the hostname from an https origin URL', async () => {
    execFileImpl.mockResolvedValue({ stdout: 'https://github.com/acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('github.com');
  });

  it('extracts the hostname from a non-github https origin URL', async () => {
    execFileImpl.mockResolvedValue({ stdout: 'https://gitlab.example.com/acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('gitlab.example.com');
  });

  it('extracts the hostname from an scp-like ssh origin URL', async () => {
    execFileImpl.mockResolvedValue({ stdout: 'git@github.com:acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('github.com');
  });

  it('extracts the hostname from an ssh:// origin URL', async () => {
    execFileImpl.mockResolvedValue({ stdout: 'ssh://git@bitbucket.example.com:2222/acme/widgets.git\n', stderr: '' });
    expect(await resolveRemoteHost('/repo')).toBe('bitbucket.example.com');
  });

  it('resolves to null when there is no origin remote / the git call fails', async () => {
    execFileImpl.mockRejectedValue(new Error('fatal: No such remote \'origin\''));
    expect(await resolveRemoteHost('/repo')).toBeNull();
  });

  it('caches the result per cwd until invalidated', async () => {
    execFileImpl.mockResolvedValue({ stdout: 'https://github.com/acme/widgets.git\n', stderr: '' });
    await resolveRemoteHost('/repo');
    await resolveRemoteHost('/repo');
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    invalidateRemoteHostCache();
    await resolveRemoteHost('/repo');
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('resolves each distinct cwd independently', async () => {
    execFileImpl.mockImplementation((_file: string, _args: string[], options: { cwd?: string }) =>
      Promise.resolve({ stdout: options.cwd === '/repo-a' ? 'https://github.com/a/a.git' : 'https://gitlab.example.com/b/b.git', stderr: '' }));
    expect(await resolveRemoteHost('/repo-a')).toBe('github.com');
    expect(await resolveRemoteHost('/repo-b')).toBe('gitlab.example.com');
  });
});
