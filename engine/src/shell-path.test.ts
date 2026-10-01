import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  looksLaunchdMinimal,
  looksGuiMinimalLinux,
  mergePath,
  fallbackPath,
  fallbackPathLinux,
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

describe('looksGuiMinimalLinux (FLUX-1711)', () => {
  const HOME = '/home/guy';

  it('flags a systemd-user default PATH (no $HOME entries) as GUI-minimal', () => {
    expect(looksGuiMinimalLinux('/usr/local/bin:/usr/bin:/bin', HOME)).toBe(true);
  });

  it('does not flag a PATH carrying any $HOME-rooted entry', () => {
    expect(looksGuiMinimalLinux('/home/guy/.local/bin:/usr/bin', HOME)).toBe(false);
    expect(looksGuiMinimalLinux('/usr/bin:/home/guy/.cargo/bin', HOME)).toBe(false);
  });

  it('never flags when HOME is unknown (no basis for the heuristic)', () => {
    expect(looksGuiMinimalLinux('/usr/bin:/bin', '')).toBe(false);
  });

  it('does not treat a sibling dir sharing the HOME prefix as $HOME-rooted', () => {
    expect(looksGuiMinimalLinux('/home/guyother/bin:/usr/bin', HOME)).toBe(true);
  });
});

describe('fallbackPathLinux (FLUX-1711)', () => {
  it('appends only user bin dirs that exist on disk, preserving the original entries', () => {
    // A nonexistent HOME → nothing can exist → PATH unchanged.
    expect(fallbackPathLinux('/usr/bin:/bin', '/nonexistent-home-xyz')).toBe('/usr/bin:/bin');
  });

  it('does not duplicate an already-present user dir', () => {
    const home = process.env.HOME || '/home/guy';
    const withLocal = `${home}/.local/bin:/usr/bin`;
    const result = fallbackPathLinux(withLocal, home);
    expect(result.split(':').filter((e) => e === `${home}/.local/bin`)).toHaveLength(1);
  });
});

describe('resolveShellPathAtStartup on linux (FLUX-1711)', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = { PATH: '/usr/local/bin:/usr/bin:/bin', SHELL: '/bin/fish', HOME: '/home/guy' };
  });

  it('adopts the login-shell PATH when the probe succeeds', async () => {
    const probe = vi.fn().mockResolvedValue('/home/guy/.local/bin:/usr/local/bin:/usr/bin');
    await resolveShellPathAtStartup({ platform: 'linux', env, probe });
    expect(probe).toHaveBeenCalledWith('/bin/fish');
    expect(env.PATH).toBe('/home/guy/.local/bin:/usr/local/bin:/usr/bin:/bin');
  });

  it('is a no-op when PATH already carries a $HOME entry', async () => {
    env.PATH = '/home/guy/.local/bin:/usr/bin';
    const probe = vi.fn();
    await resolveShellPathAtStartup({ platform: 'linux', env, probe });
    expect(probe).not.toHaveBeenCalled();
    expect(env.PATH).toBe('/home/guy/.local/bin:/usr/bin');
  });

  it('is a no-op when HOME is unknown', async () => {
    delete env.HOME;
    const probe = vi.fn();
    await resolveShellPathAtStartup({ platform: 'linux', env, probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it('falls back to appending existing user bin dirs when the probe fails', async () => {
    env.HOME = '/nonexistent-home-xyz';
    const probe = vi.fn().mockResolvedValue(null);
    await resolveShellPathAtStartup({ platform: 'linux', env, probe });
    expect(probe).toHaveBeenCalled();
    // Nothing exists under the fake HOME, so PATH is unchanged — and nothing throws.
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
  });

  it('defaults the probe shell to /bin/bash when SHELL is unset', async () => {
    delete env.SHELL;
    const probe = vi.fn().mockResolvedValue('/home/guy/bin:/usr/bin');
    await resolveShellPathAtStartup({ platform: 'linux', env, probe });
    expect(probe).toHaveBeenCalledWith('/bin/bash');
  });
});
