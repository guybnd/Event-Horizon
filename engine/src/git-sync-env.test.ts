import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the gh-auth probe so buildGitSyncEnv is deterministic without a real `gh`.
vi.mock('./branch-manager.js', () => ({ checkGhAuth: vi.fn() }));
// Mock remote-host resolution so buildGitSyncEnv is deterministic without a real git repo (FLUX-987).
vi.mock('./git-remote-host.js', () => ({ resolveRemoteHost: vi.fn() }));

import { checkGhAuth } from './branch-manager.js';
import { resolveRemoteHost } from './git-remote-host.js';
import {
  buildGitSyncEnv,
  classifyGitError,
  invalidateGhAuthCache,
  SYNC_AUTH_REMEDIATION,
} from './git-sync-env.js';

const mockCheckGhAuth = vi.mocked(checkGhAuth);
const mockResolveRemoteHost = vi.mocked(resolveRemoteHost);

describe('classifyGitError (FLUX-895)', () => {
  it('classifies network failures', () => {
    expect(classifyGitError('fatal: unable to access: Could not resolve host: github.com')).toBe('network');
    expect(classifyGitError('Failed to connect: Connection timed out')).toBe('network');
  });

  it('classifies the non-interactive credential failures as auth', () => {
    // The new failure shapes once prompting is disabled (GIT_TERMINAL_PROMPT=0):
    expect(classifyGitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe('auth');
    expect(classifyGitError('fatal: could not read Password for https://github.com')).toBe('auth');
    expect(classifyGitError('The requested URL returned error: 403')).toBe('auth');
    // Plus the classic shapes that were already covered:
    expect(classifyGitError('fatal: Authentication failed for https://github.com/x.git')).toBe('auth');
    expect(classifyGitError('remote: Permission denied')).toBe('auth');
  });

  it('falls back to unknown for non-network/non-auth errors', () => {
    expect(classifyGitError('fatal: Unable to create index.lock: File exists.')).toBe('unknown');
  });
});

describe('buildGitSyncEnv (FLUX-895)', () => {
  beforeEach(() => {
    invalidateGhAuthCache();
    mockCheckGhAuth.mockReset();
    mockResolveRemoteHost.mockReset();
  });

  it('always sets the non-interactive vars and no credential injection when gh is not authed', async () => {
    mockCheckGhAuth.mockResolvedValue(false);
    const env = await buildGitSyncEnv('/repo');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
    // gh off → leave the user's existing credential helper (GCM) in place.
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    // Not even queried when gh isn't authed — no point resolving the remote.
    expect(mockResolveRemoteHost).not.toHaveBeenCalled();
  });

  it('injects gh as the sole github.com credential helper when gh is authed AND the remote is github.com', async () => {
    mockCheckGhAuth.mockResolvedValue(true);
    mockResolveRemoteHost.mockResolvedValue('github.com');
    const env = await buildGitSyncEnv('/repo');
    expect(mockResolveRemoteHost).toHaveBeenCalledWith('/repo');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    // resets generic + github.com helper chains (empty), then sets gh:
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toBe('');
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_2).toBe('!gh auth git-credential');
  });

  // FLUX-987: gh being authed says nothing about which remote `cwd` points at. A non-github
  // remote (GitLab/Bitbucket/GH-Enterprise/self-hosted) must keep its inherited OS credential
  // helper — resetting it with no replacement caused a silent, permanent sync failure.
  it('does NOT reset the credential helper when gh is authed but the remote is not github.com', async () => {
    mockCheckGhAuth.mockResolvedValue(true);
    mockResolveRemoteHost.mockResolvedValue('gitlab.example.com');
    const env = await buildGitSyncEnv('/repo');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
  });

  it('does NOT reset the credential helper when the remote host cannot be resolved', async () => {
    mockCheckGhAuth.mockResolvedValue(true);
    mockResolveRemoteHost.mockResolvedValue(null);
    const env = await buildGitSyncEnv('/repo');
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('does NOT reset the credential helper when cwd is omitted', async () => {
    mockCheckGhAuth.mockResolvedValue(true);
    const env = await buildGitSyncEnv();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(mockResolveRemoteHost).not.toHaveBeenCalled();
  });

  it('caches the gh-auth probe until invalidated', async () => {
    mockCheckGhAuth.mockResolvedValue(true);
    mockResolveRemoteHost.mockResolvedValue('github.com');
    await buildGitSyncEnv('/repo');
    await buildGitSyncEnv('/repo');
    expect(mockCheckGhAuth).toHaveBeenCalledTimes(1); // second call served from cache
    invalidateGhAuthCache();
    await buildGitSyncEnv('/repo');
    expect(mockCheckGhAuth).toHaveBeenCalledTimes(2);
  });
});

describe('SYNC_AUTH_REMEDIATION (FLUX-895)', () => {
  it('carries the exact copy-paste fix commands in order', () => {
    expect(SYNC_AUTH_REMEDIATION.commands).toEqual(['gh auth login', 'gh auth setup-git']);
    expect(SYNC_AUTH_REMEDIATION.reason.length).toBeGreaterThan(0);
  });
});
