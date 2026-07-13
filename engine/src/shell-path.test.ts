import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  looksLaunchdMinimal,
  mergePath,
  fallbackPath,
  resolveShellPathAtStartup,
} from './shell-path.js';

describe('looksLaunchdMinimal (FLUX-1408)', () => {
  it('flags the launchd default PATH as minimal', () => {
    expect(looksLaunchdMinimal('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
  });

  it('does not flag a PATH that already has Homebrew (Apple Silicon)', () => {
    expect(looksLaunchdMinimal('/opt/homebrew/bin:/usr/bin:/bin')).toBe(false);
  });

  it('does not flag a PATH that already has Homebrew (Intel)', () => {
    expect(looksLaunchdMinimal('/usr/local/bin:/usr/bin:/bin')).toBe(false);
  });

  it('treats an empty/undefined PATH as minimal', () => {
    expect(looksLaunchdMinimal(undefined)).toBe(true);
    expect(looksLaunchdMinimal('')).toBe(true);
  });
});

describe('mergePath (FLUX-1408)', () => {
  it('puts the shell-resolved PATH first and de-dupes overlapping entries', () => {
    const merged = mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin');
    expect(merged).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('drops empty segments', () => {
    const merged = mergePath('/opt/homebrew/bin::', ':/usr/bin');
    expect(merged).toBe('/opt/homebrew/bin:/usr/bin');
  });
});

describe('fallbackPath (FLUX-1408)', () => {
  it('appends only Homebrew dirs that exist on disk', () => {
    // /usr/bin and /bin always exist on a real machine; only assert on the
    // absolute worst case (neither Homebrew dir exists) to stay host-independent.
    const result = fallbackPath('/usr/bin:/bin');
    expect(result.startsWith('/usr/bin:/bin')).toBe(true);
  });

  it('does not duplicate an already-present Homebrew dir', () => {
    const result = fallbackPath('/opt/homebrew/bin:/usr/bin');
    expect(result.split(':').filter((e) => e === '/opt/homebrew/bin')).toHaveLength(1);
  });
});

describe('resolveShellPathAtStartup (FLUX-1408)', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' };
  });

  it('is a no-op off darwin', async () => {
    const probe = vi.fn();
    await resolveShellPathAtStartup({ platform: 'win32', env, probe });
    expect(probe).not.toHaveBeenCalled();
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('is a no-op when PATH already has Homebrew', async () => {
    env.PATH = '/opt/homebrew/bin:/usr/bin:/bin';
    const probe = vi.fn();
    await resolveShellPathAtStartup({ platform: 'darwin', env, probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it('adopts the login-shell PATH when the probe succeeds', async () => {
    const probe = vi.fn().mockResolvedValue('/opt/homebrew/bin:/usr/bin:/bin');
    await resolveShellPathAtStartup({ platform: 'darwin', env, probe });
    expect(probe).toHaveBeenCalledWith('/bin/zsh');
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('falls back to appending existing Homebrew dirs when the probe fails', async () => {
    const probe = vi.fn().mockResolvedValue(null);
    await resolveShellPathAtStartup({ platform: 'darwin', env, probe });
    expect(probe).toHaveBeenCalled();
    // Result is unchanged unless a Homebrew dir actually exists on this machine —
    // just assert the original entries are preserved and nothing throws.
    expect(env.PATH!.startsWith('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
  });

  it('respects an explicit SHELL override', async () => {
    env.SHELL = '/bin/bash';
    const probe = vi.fn().mockResolvedValue('/opt/homebrew/bin');
    await resolveShellPathAtStartup({ platform: 'darwin', env, probe });
    expect(probe).toHaveBeenCalledWith('/bin/bash');
  });
});
