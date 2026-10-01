import { describe, it, expect } from 'vitest';
import { parseCliVersion, CLI_BINARIES } from './cli-version.js';
import { CLI_CAPABILITIES } from './types.js';

describe('parseCliVersion', () => {
  it('takes the first semver token whatever the CLI wraps it in', () => {
    expect(parseCliVersion('2.1.260 (Claude Code)\n')).toBe('2.1.260');
    expect(parseCliVersion('codex-cli 0.44.0')).toBe('0.44.0');
    expect(parseCliVersion('v1.2.3-beta.1\n')).toBe('1.2.3-beta.1');
  });

  it('falls back to the first line when there is no semver, and null on empty output', () => {
    expect(parseCliVersion('build 20260905\nsomething')).toBe('build 20260905');
    expect(parseCliVersion('   ')).toBeNull();
  });

  it('knows a binary for every framework the engine supports', () => {
    for (const fw of Object.keys(CLI_CAPABILITIES)) {
      expect(CLI_BINARIES[fw as keyof typeof CLI_BINARIES]).toBeTruthy();
    }
  });
});
