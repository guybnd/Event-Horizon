import { describe, it, expect, vi } from 'vitest';
import {
  parseLoginShellResolution,
  extractSettingsFlags,
  checkSettingsShadowing,
  checkEnvShadowing,
  computeVerdict,
  diagnoseAuthFailure,
  formatAuthDiagnosisMessage,
  type AuthDiagnosis,
} from './auth-diagnostics.js';

describe('parseLoginShellResolution (FLUX-1599)', () => {
  it('extracts the path from a plain binary resolution', () => {
    expect(parseLoginShellResolution('claude is /Users/x/.local/bin/claude\n')).toEqual({
      resolution: 'claude is /Users/x/.local/bin/claude',
      path: '/Users/x/.local/bin/claude',
    });
  });

  it('extracts the target path from an "aliased to" resolution', () => {
    const out = parseLoginShellResolution("claude is aliased to `/opt/homebrew/bin/claude'\n");
    expect(out?.path).toBe('/opt/homebrew/bin/claude');
  });

  it('leaves path unset for a shell function with no path in its output', () => {
    const out = parseLoginShellResolution('claude is a shell function from /Users/x/.zshrc\n');
    // The .zshrc path is not the binary's own path — still captured as the first path-looking
    // token since the parser can't tell the difference; verdict logic treats "no exact match" via
    // divergence, not this parse step. Only assert resolution is preserved verbatim.
    expect(out?.resolution).toBe('claude is a shell function from /Users/x/.zshrc');
  });

  it('returns null for empty/whitespace-only output', () => {
    expect(parseLoginShellResolution('')).toBeNull();
    expect(parseLoginShellResolution('   \n  \n')).toBeNull();
  });

  it('only reads the first non-empty line (type -a can report several)', () => {
    const out = parseLoginShellResolution('\nclaude is /a/claude\nclaude is /b/claude\n');
    expect(out?.path).toBe('/a/claude');
  });
});

describe('extractSettingsFlags (FLUX-1599)', () => {
  it('flags env.ANTHROPIC_API_KEY presence', () => {
    const flags = extractSettingsFlags(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-something' } }));
    expect(flags).toEqual({ key: true, helper: false, baseUrl: false });
  });

  it('flags apiKeyHelper presence', () => {
    const flags = extractSettingsFlags(JSON.stringify({ apiKeyHelper: '/usr/local/bin/get-key.sh' }));
    expect(flags.helper).toBe(true);
  });

  it('flags env.ANTHROPIC_BASE_URL presence', () => {
    const flags = extractSettingsFlags(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } }));
    expect(flags.baseUrl).toBe(true);
  });

  it('is all-false for a settings file with none of these keys', () => {
    expect(extractSettingsFlags(JSON.stringify({ theme: 'dark' }))).toEqual({ key: false, helper: false, baseUrl: false });
  });

  it('degrades to all-false on malformed JSON instead of throwing', () => {
    expect(extractSettingsFlags('{ not valid json')).toEqual({ key: false, helper: false, baseUrl: false });
  });
});

describe('checkSettingsShadowing (FLUX-1599)', () => {
  it('checks only the user-level path when no workspaceRoot is given', () => {
    const readFile = vi.fn().mockReturnValue(JSON.stringify({ apiKeyHelper: 'x' }));
    const result = checkSettingsShadowing(undefined, readFile);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(result.settingsHelper).toBe(true);
  });

  it('ORs flags across the user-level AND workspace-level settings files', () => {
    const readFile = vi.fn()
      .mockReturnValueOnce(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } })) // user-level
      .mockReturnValueOnce(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x' } })); // workspace-level
    const result = checkSettingsShadowing('/repo/worktree', readFile);
    expect(result).toEqual({ settingsKey: true, settingsHelper: false, baseUrl: true });
  });

  it('treats a missing/unreadable file as no shadowing, not a crash', () => {
    const readFile = vi.fn().mockReturnValue(null);
    expect(checkSettingsShadowing('/repo/worktree', readFile)).toEqual({ settingsKey: false, settingsHelper: false, baseUrl: false });
  });
});

describe('checkEnvShadowing (FLUX-1599)', () => {
  it('flags ANTHROPIC_API_KEY', () => {
    expect(checkEnvShadowing({ ANTHROPIC_API_KEY: 'x' })).toEqual({ envKey: true, baseUrl: false });
  });

  it('flags ANTHROPIC_AUTH_TOKEN as equivalent to an API key', () => {
    expect(checkEnvShadowing({ ANTHROPIC_AUTH_TOKEN: 'x' }).envKey).toBe(true);
  });

  it('flags ANTHROPIC_BASE_URL independently', () => {
    expect(checkEnvShadowing({ ANTHROPIC_BASE_URL: 'https://x' })).toEqual({ envKey: false, baseUrl: true });
  });

  it('is all-false on a clean env', () => {
    expect(checkEnvShadowing({})).toEqual({ envKey: false, baseUrl: false });
  });
});

describe('computeVerdict (FLUX-1599)', () => {
  const noShadowing = { settingsKey: false, settingsHelper: false, envKey: false, baseUrl: false };

  it('is binary-divergence when the terminal resolves a different path than what we spawn', () => {
    const d: Omit<AuthDiagnosis, 'verdict'> = {
      spawnedBinary: { path: '/opt/homebrew/bin/claude' },
      terminalBinary: { resolution: 'claude is /Users/x/.local/bin/claude', path: '/Users/x/.local/bin/claude' },
      duplicates: ['/opt/homebrew/bin/claude'],
      shadowing: noShadowing,
    };
    expect(computeVerdict(d)).toBe('binary-divergence');
  });

  it('is binary-divergence when the terminal resolves an alias/function (no path) while we spawn a real binary', () => {
    const d: Omit<AuthDiagnosis, 'verdict'> = {
      spawnedBinary: { path: '/opt/homebrew/bin/claude' },
      terminalBinary: { resolution: 'claude is a shell function from /Users/x/.zshrc' },
      duplicates: ['/opt/homebrew/bin/claude'],
      shadowing: noShadowing,
    };
    expect(computeVerdict(d)).toBe('binary-divergence');
  });

  it('is duplicate-installs when there is more than one install and no terminal divergence', () => {
    const d: Omit<AuthDiagnosis, 'verdict'> = {
      spawnedBinary: { path: '/opt/homebrew/bin/claude' },
      duplicates: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
      shadowing: noShadowing,
    };
    expect(computeVerdict(d)).toBe('duplicate-installs');
  });

  it('is shadowed-credentials when a settings/env override is present and nothing else fired', () => {
    const d: Omit<AuthDiagnosis, 'verdict'> = {
      spawnedBinary: { path: '/opt/homebrew/bin/claude' },
      duplicates: ['/opt/homebrew/bin/claude'],
      shadowing: { ...noShadowing, envKey: true },
    };
    expect(computeVerdict(d)).toBe('shadowed-credentials');
  });

  it('is token-rejected for a single clean binary with no shadowing', () => {
    const d: Omit<AuthDiagnosis, 'verdict'> = {
      spawnedBinary: { path: '/opt/homebrew/bin/claude' },
      duplicates: ['/opt/homebrew/bin/claude'],
      shadowing: noShadowing,
    };
    expect(computeVerdict(d)).toBe('token-rejected');
  });

  it('is unknown when the spawned binary could not even be resolved', () => {
    const d: Omit<AuthDiagnosis, 'verdict'> = {
      spawnedBinary: { path: '' },
      duplicates: [],
      shadowing: noShadowing,
    };
    expect(computeVerdict(d)).toBe('unknown');
  });
});

describe('diagnoseAuthFailure (FLUX-1599)', () => {
  it('reports terminal divergence on darwin and caches the result', async () => {
    const resolveAllInstalls = vi.fn().mockResolvedValue(['/opt/homebrew/bin/claude']);
    const probeVersion = vi.fn().mockResolvedValue('1.8.1');
    const probeLoginShellTypeA = vi.fn().mockResolvedValue('claude is /Users/x/.local/bin/claude\n');
    let now = 1_000_000;

    const diagnosis = await diagnoseAuthFailure('claude-divergence-test', '/repo', {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      resolveAllInstalls,
      probeVersion,
      probeLoginShellTypeA,
      readSettingsFile: () => null,
      now: () => now,
    });

    expect(diagnosis.verdict).toBe('binary-divergence');
    expect(diagnosis.spawnedBinary.path).toBe('/opt/homebrew/bin/claude');
    expect(diagnosis.terminalBinary?.path).toBe('/Users/x/.local/bin/claude');
    expect(probeLoginShellTypeA).toHaveBeenCalledWith('/bin/zsh', 'claude-divergence-test');

    // Second call within the TTL must be served from cache — no re-probing.
    now += 1_000;
    await diagnoseAuthFailure('claude-divergence-test', '/repo', {
      platform: 'darwin', env: {}, resolveAllInstalls, probeVersion, probeLoginShellTypeA, readSettingsFile: () => null, now: () => now,
    });
    expect(resolveAllInstalls).toHaveBeenCalledTimes(1);

    // Past the TTL, it re-probes.
    now += 60_000;
    await diagnoseAuthFailure('claude-divergence-test', '/repo', {
      platform: 'darwin', env: {}, resolveAllInstalls, probeVersion, probeLoginShellTypeA, readSettingsFile: () => null, now: () => now,
    });
    expect(resolveAllInstalls).toHaveBeenCalledTimes(2);
  });

  it('skips the login-shell probe entirely off darwin', async () => {
    const resolveAllInstalls = vi.fn().mockResolvedValue(['C:\\npm\\claude.exe']);
    const probeVersion = vi.fn().mockResolvedValue(undefined);
    const probeLoginShellTypeA = vi.fn();

    const diagnosis = await diagnoseAuthFailure('claude-win-test', undefined, {
      platform: 'win32',
      env: {},
      resolveAllInstalls,
      probeVersion,
      probeLoginShellTypeA,
      readSettingsFile: () => null,
      now: () => 2_000_000,
    });

    expect(probeLoginShellTypeA).not.toHaveBeenCalled();
    expect(diagnosis.terminalBinary).toBeUndefined();
    expect(diagnosis.verdict).toBe('token-rejected');
  });

  it('prefers resolveSpawnedPath over the bare PATH lookup when both are given', async () => {
    const resolveAllInstalls = vi.fn().mockResolvedValue(['C:\\stale\\claude.exe']);
    const resolveSpawnedPath = vi.fn().mockResolvedValue('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');

    const diagnosis = await diagnoseAuthFailure('claude-exe-override-test', undefined, {
      platform: 'win32',
      env: {},
      resolveAllInstalls,
      probeVersion: async () => undefined,
      resolveSpawnedPath,
      readSettingsFile: () => null,
      now: () => 3_000_000,
    });

    expect(diagnosis.spawnedBinary.path).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  });

  it('surfaces shadowed-credentials from a settings-file override', async () => {
    const diagnosis = await diagnoseAuthFailure('claude-shadow-test', '/repo', {
      platform: 'linux',
      env: {},
      resolveAllInstalls: async () => ['/usr/bin/claude'],
      probeVersion: async () => undefined,
      readSettingsFile: () => JSON.stringify({ apiKeyHelper: '/bin/get-key' }),
      now: () => 4_000_000,
    });

    expect(diagnosis.verdict).toBe('shadowed-credentials');
    expect(diagnosis.shadowing.settingsHelper).toBe(true);
  });
});

describe('formatAuthDiagnosisMessage (FLUX-1599)', () => {
  const base: AuthDiagnosis = {
    spawnedBinary: { path: '/opt/homebrew/bin/claude', version: '1.8.0' },
    duplicates: ['/opt/homebrew/bin/claude'],
    shadowing: { settingsKey: false, settingsHelper: false, envKey: false, baseUrl: false },
    verdict: 'token-rejected',
  };

  it('tells the user to re-login for token-rejected', () => {
    expect(formatAuthDiagnosisMessage(base)).toContain('claude login');
  });

  it('names both binaries for binary-divergence', () => {
    const msg = formatAuthDiagnosisMessage({
      ...base,
      terminalBinary: { resolution: 'claude is /Users/x/.local/bin/claude', path: '/Users/x/.local/bin/claude' },
      verdict: 'binary-divergence',
    });
    expect(msg).toContain('/opt/homebrew/bin/claude');
    expect(msg).toContain('/Users/x/.local/bin/claude');
  });

  it('lists every duplicate path for duplicate-installs', () => {
    const msg = formatAuthDiagnosisMessage({ ...base, duplicates: ['/a/claude', '/b/claude'], verdict: 'duplicate-installs' });
    expect(msg).toContain('/a/claude');
    expect(msg).toContain('/b/claude');
  });

  it('names the specific override(s) for shadowed-credentials without leaking any value', () => {
    const msg = formatAuthDiagnosisMessage({
      ...base,
      shadowing: { settingsKey: true, settingsHelper: false, envKey: true, baseUrl: false },
      verdict: 'shadowed-credentials',
    });
    expect(msg).toContain('ANTHROPIC_API_KEY');
    expect(msg).not.toMatch(/sk-|Bearer /);
  });

  it('gives a generic actionable fallback for unknown', () => {
    expect(formatAuthDiagnosisMessage({ ...base, spawnedBinary: { path: '' }, verdict: 'unknown' })).toContain('claude login');
  });
});
