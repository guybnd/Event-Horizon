import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveClaudeBinaryPathDarwin,
  invalidateClaudeBinaryDarwinCache,
  resetClaudeBinaryDarwinCacheForTest,
} from './claude-binary-darwin.js';

// FLUX-1600: resolveClaudeBinaryPathDarwin is the darwin twin of resolveClaudeExePath
// (shared.ts) — resolves `claude` the way the user's LOGIN SHELL would (command -v, falling
// back to type -a for an alias/function), instead of the bare PATH lookup `spawn('claude', …)`
// does today. Tested via injected `deps` (platform/env/probe) rather than the real host
// platform/shell, mirroring shell-path.test.ts's resolveShellPathAtStartup pattern — this repo's
// dev/CI host is not macOS, so the darwin branch can only be exercised through dependency
// injection, never the ambient `process.platform`.
describe('resolveClaudeBinaryPathDarwin (FLUX-1600)', () => {
  beforeEach(() => {
    resetClaudeBinaryDarwinCacheForTest();
  });

  it('resolves to null immediately on non-darwin platforms without probing', async () => {
    const probe = vi.fn();
    await expect(resolveClaudeBinaryPathDarwin('claude', { platform: 'win32', probe })).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('resolves the real path when `command -v` returns an absolute path directly', async () => {
    const probe = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    const result = await resolveClaudeBinaryPathDarwin('claude', {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      probe,
    });
    expect(result).toBe('/Users/guy/.local/bin/claude');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('/bin/zsh', expect.stringContaining('command -v claude'));
  });

  it('falls back to `type -a` and extracts a real path when `command -v` reports an alias', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce("claude='/opt/homebrew/bin/claude --model sonnet'") // command -v: alias text, not a path
      .mockResolvedValueOnce("claude is an alias for /opt/homebrew/bin/claude --model sonnet"); // type -a
    const result = await resolveClaudeBinaryPathDarwin('claude', {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      probe,
    });
    expect(result).toBe('/opt/homebrew/bin/claude');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenNthCalledWith(2, '/bin/zsh', expect.stringContaining('type -a claude'));
  });

  it('takes the first real path type -a reports when multiple lines are returned', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce('claude is a shell function') // command -v: function, no path at all
      .mockResolvedValueOnce([
        'claude is a shell function from /Users/guy/.zshrc',
        'claude is /Users/guy/.local/bin/claude',
        'claude is /opt/homebrew/bin/claude',
      ].join('\n'));
    const result = await resolveClaudeBinaryPathDarwin('claude', {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      probe,
    });
    expect(result).toBe('/Users/guy/.local/bin/claude');
  });

  it('falls back to bare PATH spawn (null) when neither probe yields a usable path', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce('claude is a shell function') // command -v: no path
      .mockResolvedValueOnce('claude is a shell function from /Users/guy/.zshrc'); // type -a: still no /…/claude path
    const result = await resolveClaudeBinaryPathDarwin('claude', {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      probe,
    });
    expect(result).toBeNull();
  });

  it('caches a resolved path across calls — the probe only runs once', async () => {
    const probe = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    const deps = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' }, probe };
    const first = await resolveClaudeBinaryPathDarwin('claude', deps);
    const second = await resolveClaudeBinaryPathDarwin('claude', deps);
    expect(first).toBe('/Users/guy/.local/bin/claude');
    expect(second).toBe('/Users/guy/.local/bin/claude');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caches a definitive "no override" (null) result too — no re-probing on the next spawn', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce('claude is a shell function')
      .mockResolvedValueOnce('claude is a shell function from /Users/guy/.zshrc');
    const deps = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' }, probe };
    await resolveClaudeBinaryPathDarwin('claude', deps);
    const second = await resolveClaudeBinaryPathDarwin('claude', deps);
    expect(second).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2); // only the FIRST resolveClaudeBinaryPathDarwin call's two probes
  });

  it('treats a probe timeout/failure (null from the shell) as TRANSIENT — not cached, retried next call', async () => {
    const failingProbe = vi.fn().mockResolvedValue(null);
    const deps = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' } };
    const first = await resolveClaudeBinaryPathDarwin('claude', { ...deps, probe: failingProbe });
    expect(first).toBeNull();

    // A subsequent call with a NOW-working probe must still resolve — proof the failed attempt
    // above never poisoned the module cache (mirrors resolveClaudeExePath's FLUX-985 rule).
    const workingProbe = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    const second = await resolveClaudeBinaryPathDarwin('claude', { ...deps, probe: workingProbe });
    expect(second).toBe('/Users/guy/.local/bin/claude');
    expect(workingProbe).toHaveBeenCalled();
  });

  it('treats a type -a timeout/failure as transient too, after an alias command -v result', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce('claude is a shell function') // command -v: no path, triggers type -a
      .mockResolvedValueOnce(null); // type -a: probe itself failed
    const deps = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' }, probe };
    const result = await resolveClaudeBinaryPathDarwin('claude', deps);
    expect(result).toBeNull();

    // Not cached — the next call re-probes from scratch.
    const probe2 = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    const second = await resolveClaudeBinaryPathDarwin('claude', { ...deps, probe: probe2 });
    expect(second).toBe('/Users/guy/.local/bin/claude');
  });

  it('respects an explicit SHELL override', async () => {
    const probe = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    await resolveClaudeBinaryPathDarwin('claude', { platform: 'darwin', env: { SHELL: '/bin/bash' }, probe });
    expect(probe).toHaveBeenCalledWith('/bin/bash', expect.any(String));
  });

  it('defaults SHELL to /bin/zsh when unset', async () => {
    const probe = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    await resolveClaudeBinaryPathDarwin('claude', { platform: 'darwin', env: {}, probe });
    expect(probe).toHaveBeenCalledWith('/bin/zsh', expect.any(String));
  });

  it('invalidateClaudeBinaryDarwinCache forces a re-probe on the next call', async () => {
    const probe = vi.fn().mockResolvedValue('/Users/guy/.local/bin/claude');
    const deps = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' }, probe };
    await resolveClaudeBinaryPathDarwin('claude', deps);
    expect(probe).toHaveBeenCalledTimes(1);

    invalidateClaudeBinaryDarwinCache();

    await resolveClaudeBinaryPathDarwin('claude', deps);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
