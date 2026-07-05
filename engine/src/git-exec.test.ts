import { describe, it, expect, vi } from 'vitest';

// Hermetic: stub the credential-env builder so the runner never spawns a real `gh auth status`.
// The mock also lets us assert the env it returns is actually applied to the child.
vi.mock('./git-sync-env.js', () => ({
  GIT_SYNC_TIMEOUT_MS: 60_000,
  buildGitSyncEnv: vi.fn(async () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })),
}));

import { runHardened, setGitOperationSink, redactArg, type GitOperationEvent } from './git-exec.js';

// runHardened's contract is git|gh, but its timeout/kill machinery is command-agnostic — drive it
// with the node binary (a deterministic, cross-platform stand-in for a hanging/returning process).
const NODE = process.execPath as unknown as 'git';

describe('git-exec runHardened', () => {
  it('times out, tree-kills the hung child, and rejects with a "timed out" error (not a pending-forever promise)', async () => {
    const start = Date.now();
    await expect(
      runHardened(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/i);
    // Returned right around the 300ms deadline — the whole point of FLUX-996.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('settles at the deadline even when the child forked a grandchild that inherits its stdio (POSIX tree-kill)', async () => {
    // Regression for FLUX-997: git forks git-remote-https/ssh, which inherit git's stdout/stderr
    // pipe. execFile's callback fires on stdio 'close', not 'exit' — so if the grandchild survives
    // the kill it holds the pipe open and the promise hangs forever. A single-PID kill of only the
    // parent leaves the grandchild alive; the detached process-group kill reaps it too. This stand-in
    // spawns such an stdio-inheriting grandchild and never exits on its own.
    const standin = [
      '-e',
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000);",
    ];
    const start = Date.now();
    await expect(runHardened(NODE, standin, { timeoutMs: 300 })).rejects.toThrow(/timed out/i);
    // If the grandchild were orphaned holding the inherited pipe, the callback would never fire and
    // this would exceed vitest's default timeout instead of returning right after the deadline.
    expect(Date.now() - start).toBeLessThan(4_000);
  });

  it('applies the non-interactive env from buildGitSyncEnv to the child', async () => {
    const { stdout } = await runHardened(
      NODE,
      ['-e', 'process.stdout.write(process.env.GIT_TERMINAL_PROMPT || "unset")'],
      { timeoutMs: 5_000 },
    );
    expect(stdout).toBe('0');
  });

  it('resolves stdout on success', async () => {
    const { stdout } = await runHardened(NODE, ['-e', 'process.stdout.write("hello")'], { timeoutMs: 5_000 });
    expect(stdout).toBe('hello');
  });

  it('rejects on a non-zero exit', async () => {
    await expect(runHardened(NODE, ['-e', 'process.exit(3)'], { timeoutMs: 5_000 })).rejects.toBeTruthy();
  });

  it('aborts promptly via an external AbortSignal', async () => {
    const ac = new AbortController();
    const p = runHardened(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('emits a telemetry event per call with the right outcome', async () => {
    const events: GitOperationEvent[] = [];
    setGitOperationSink((e) => events.push(e));
    try {
      await runHardened(NODE, ['-e', ''], { timeoutMs: 5_000 });
      await expect(
        runHardened(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      setGitOperationSink(null);
    }
    expect(events.map((e) => e.outcome)).toEqual(['ok', 'timeout']);
    expect(events).toHaveLength(2);
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('supports multiple concurrent sinks (multicast) — a second setGitOperationSink() call adds, never replaces (FLUX-1131)', async () => {
    const a: GitOperationEvent[] = [];
    const b: GitOperationEvent[] = [];
    setGitOperationSink((e) => a.push(e));
    setGitOperationSink((e) => b.push(e));
    try {
      await runHardened(NODE, ['-e', ''], { timeoutMs: 5_000 });
    } finally {
      setGitOperationSink(null);
    }
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.outcome).toBe('ok');
    expect(b[0]!.outcome).toBe('ok');
  });

  it('a throwing telemetry sink never breaks the git call', async () => {
    setGitOperationSink(() => { throw new Error('sink boom'); });
    try {
      await expect(runHardened(NODE, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 5_000 }))
        .resolves.toMatchObject({ stdout: 'ok' });
    } finally {
      setGitOperationSink(null);
    }
  });

  it('redacts a credential-embedded URL echoed in stderr from the thrown Error.message (FLUX-1002 review)', async () => {
    // Callers like cli-session.ts's prepareAndLaunchSession now persist error.message into synced
    // ticket history / SSE broadcasts — the credential-URL redaction has to happen HERE, at the one
    // place every git/gh spawn funnels through, so every caller gets it for free.
    const standin = [
      '-e',
      "process.stderr.write('fatal: could not read from https://x-access-token:ghs_SECRET123@github.com/org/repo.git'); process.exit(1);",
    ];
    await expect(runHardened(NODE, standin, { timeoutMs: 5_000 })).rejects.toThrow(
      /https:\/\/\*\*\*@github\.com\/org\/repo\.git/,
    );
    try {
      await runHardened(NODE, standin, { timeoutMs: 5_000 });
      expect.unreachable('expected runHardened to reject');
    } catch (err) {
      expect((err as Error).message).not.toContain('ghs_SECRET123');
    }
  });

  it('redacts a credential-embedded URL from the thrown Error .stdout/.stderr too, not just .message (FLUX-1091)', async () => {
    // FLUX-1002 only redacted .message; the same Error also carries raw .stdout/.stderr, which
    // would leak the credential if a future caller logs/persists those fields instead of .message.
    const standin = [
      '-e',
      "process.stdout.write('https://x-access-token:ghs_SECRET123@github.com/org/repo.git'); " +
        "process.stderr.write('fatal: could not read from https://x-access-token:ghs_SECRET123@github.com/org/repo.git'); process.exit(1);",
    ];
    try {
      await runHardened(NODE, standin, { timeoutMs: 5_000 });
      expect.unreachable('expected runHardened to reject');
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      expect(e.stdout).not.toContain('ghs_SECRET123');
      expect(e.stderr).not.toContain('ghs_SECRET123');
      expect(e.stdout).toMatch(/https:\/\/\*\*\*@github\.com\/org\/repo\.git/);
      expect(e.stderr).toMatch(/https:\/\/\*\*\*@github\.com\/org\/repo\.git/);
    }
  });

  it('redactArg strips embedded userinfo from any scheme://user:pass@host URL', () => {
    expect(redactArg('https://x-access-token:ghs_SECRET@github.com/org/repo.git')).toBe(
      'https://***@github.com/org/repo.git',
    );
    expect(redactArg('no url here')).toBe('no url here');
  });
});
