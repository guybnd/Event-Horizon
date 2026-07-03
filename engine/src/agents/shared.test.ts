import { describe, it, expect } from 'vitest';
import { checkBinaryInstalled, resolveClaudeExePath, isDefinitiveNotInstalled } from './shared.js';

// FLUX-1003 (epic FLUX-996): checkBinaryInstalled/resolveClaudeExePath were converted from
// execFileSync/execSync (SYNCHRONOUS — blocking the whole event loop on every spawn/reply) to
// async equivalents, plus caching. Tested against real subprocesses (mirrors the existing
// "tested against real git" pattern in task-worktree.test.ts) rather than mocking child_process,
// since the caching wraps `promisify(execFile)` at module-load time — a post-hoc child_process
// spy wouldn't intercept the already-captured reference, making that style of test unreliable.
describe('checkBinaryInstalled (async, cached)', () => {
  it('is a Promise-returning function (never blocks the event loop)', () => {
    // The historical bug: execFileSync's synchronous nature. Asserting the return type is a
    // Promise is the structural guarantee that this can no longer stall the shared event loop.
    const result = checkBinaryInstalled('node');
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('resolves for a binary genuinely on PATH', async () => {
    // 'node' is guaranteed present — this process is running under it.
    await expect(checkBinaryInstalled('node')).resolves.toBeUndefined();
  });

  it('resolves again immediately from the positive cache (no re-spawn needed to pass)', async () => {
    await checkBinaryInstalled('node');
    await expect(checkBinaryInstalled('node')).resolves.toBeUndefined();
  });

  it('rejects with an actionable message for a binary that is not installed', async () => {
    await expect(checkBinaryInstalled('eh-definitely-not-a-real-binary-xyz123'))
      .rejects.toThrow(/not installed or not on PATH/);
  });

  it('rejects consistently on a second call within the negative-cache TTL', async () => {
    const binary = 'eh-definitely-not-a-real-binary-abc789';
    await expect(checkBinaryInstalled(binary)).rejects.toThrow(/not installed or not on PATH/);
    // Second call must still reject (served from the negative cache, not a fluke PATH change).
    await expect(checkBinaryInstalled(binary)).rejects.toThrow(/not installed or not on PATH/);
  });
});

// FLUX-1016: checkBinaryInstalled must only negative-cache a DEFINITIVE "not installed" (clean
// non-zero exit of which/where) — a transient checker failure (10s timeout, or which/where itself
// failing to spawn) must NOT poison the 30s negative cache, mirroring resolveClaudeExePath's
// transient-not-cached rule (FLUX-985). A real 10s timeout can't be triggered deterministically in
// a unit test, so the cache-or-not decision is factored into this pure predicate and tested here.
describe('isDefinitiveNotInstalled (cache-decision predicate)', () => {
  it('treats a clean non-zero exit (numeric code, not killed, no signal) as definitive', () => {
    // `which`/`where` exiting 1 because the binary is genuinely absent → safe to negative-cache.
    expect(isDefinitiveNotInstalled({ code: 1, killed: false, signal: null })).toBe(true);
  });

  it('treats a timeout (killed by our 10s cap) as transient — not cached', () => {
    // Node kills a timed-out child: killed=true, signal set, code null.
    expect(isDefinitiveNotInstalled({ code: null, killed: true, signal: 'SIGTERM' })).toBe(false);
  });

  it('treats a signal-terminated checker as transient even if not flagged killed', () => {
    expect(isDefinitiveNotInstalled({ code: null, killed: false, signal: 'SIGKILL' })).toBe(false);
  });

  it('treats a checker spawn error (string code like ENOENT) as transient — not cached', () => {
    expect(isDefinitiveNotInstalled({ code: 'ENOENT', killed: false, signal: null })).toBe(false);
  });
});

describe('resolveClaudeExePath (async, cached)', () => {
  it('is a Promise-returning function (never blocks the event loop)', () => {
    const result = resolveClaudeExePath();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('resolves to null immediately on non-Windows platforms', async () => {
    if (process.platform === 'win32') return; // this test's guarantee only holds off-Windows
    await expect(resolveClaudeExePath()).resolves.toBeNull();
  });
});
