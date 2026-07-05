// S9 (epic FLUX-996): the operation-telemetry ring buffer, its query filters, and the adapter that
// wires git-exec's GitOperationEvent into it.

// Hermetic, same as git-exec.test.ts: stub the credential-env builder so runHardened (driven via
// the installOperationTelemetry() tests below) never spawns a real `gh auth status`.
vi.mock('./git-sync-env.js', () => ({
  GIT_SYNC_TIMEOUT_MS: 60_000,
  buildGitSyncEnv: vi.fn(async () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })),
}));

import { describe, it, expect, vi } from 'vitest';
import { emitOperationEvent, getRecentOperations, installOperationTelemetry, stopOperationTelemetry, _getBufferLengthForTests } from './operation-telemetry.js';
import { runHardened } from './git-exec.js';

// Stand-in for 'git' — see git-exec.test.ts for why: deterministic, cross-platform, no real remote.
const NODE = process.execPath as unknown as 'git';

describe('getRecentOperations filters', () => {
  it('returns newest-first', () => {
    const ticketId = `order-${Math.random()}`;
    emitOperationEvent({ kind: 'spawn', ticketId, cmd: 'first', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    emitOperationEvent({ kind: 'spawn', ticketId, cmd: 'second', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    emitOperationEvent({ kind: 'spawn', ticketId, cmd: 'third', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });

    expect(getRecentOperations({ ticketId }).map((e) => e.cmd)).toEqual(['third', 'second', 'first']);
  });

  it('honors ticketId, sessionId, kind, and outcome filters independently', () => {
    const marker = `${Date.now()}-${Math.random()}`;
    emitOperationEvent({ kind: 'git', ticketId: `t-${marker}`, sessionId: `s-${marker}`, cmd: 'a', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    emitOperationEvent({ kind: 'gh', ticketId: `t-${marker}`, sessionId: `other-${marker}`, cmd: 'b', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'error' });
    emitOperationEvent({ kind: 'handshake', ticketId: `other-${marker}`, sessionId: `s-${marker}`, cmd: 'c', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'timeout' });

    expect(getRecentOperations({ ticketId: `t-${marker}` }).map((e) => e.cmd).sort()).toEqual(['a', 'b']);
    expect(getRecentOperations({ sessionId: `s-${marker}` }).map((e) => e.cmd).sort()).toEqual(['a', 'c']);
    expect(getRecentOperations({ kind: 'gh', ticketId: `t-${marker}` }).map((e) => e.cmd)).toEqual(['b']);
    expect(getRecentOperations({ outcome: 'timeout', ticketId: `other-${marker}` }).map((e) => e.cmd)).toEqual(['c']);
  });

  it('defaults limit to 100 and honors an explicit smaller limit', () => {
    const ticketId = `limit-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 150; i++) {
      emitOperationEvent({ kind: 'spawn', ticketId, cmd: `op-${i}`, startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    }
    expect(getRecentOperations({ ticketId })).toHaveLength(100);
    expect(getRecentOperations({ ticketId, limit: 5 })).toHaveLength(5);
    // Newest-first: the last emitted (op-149) leads.
    expect(getRecentOperations({ ticketId, limit: 1 })[0]!.cmd).toBe('op-149');
  });

  it('returns an empty array for a ticketId that was never emitted — never throws', () => {
    expect(getRecentOperations({ ticketId: `never-seen-${Date.now()}` })).toEqual([]);
  });

  it('gives distinct opIds to concurrent same-ticketId events (no clobbering)', () => {
    const ticketId = `race-${Date.now()}-${Math.random()}`;
    emitOperationEvent({ kind: 'spawn', ticketId, cmd: 'a', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    emitOperationEvent({ kind: 'spawn', ticketId, cmd: 'b', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    const events = getRecentOperations({ ticketId });
    expect(events).toHaveLength(2);
    expect(events[0]!.opId).not.toBe(events[1]!.opId);
  });
});

describe('ring buffer eviction', () => {
  it('never exceeds capacity (500) and evicts oldest-first under sustained high-frequency emission', () => {
    const firstMarker = `evict-first-${Date.now()}-${Math.random()}`;
    const lastMarker = `evict-last-${Date.now()}-${Math.random()}`;

    emitOperationEvent({ kind: 'git', ticketId: firstMarker, cmd: 'x', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    for (let i = 0; i < 698; i++) {
      emitOperationEvent({ kind: 'git', cmd: 'filler', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });
    }
    emitOperationEvent({ kind: 'git', ticketId: lastMarker, cmd: 'x', startedAt: 0, endedAt: 1, durationMs: 1, outcome: 'ok' });

    // 700 pushes total (this test) guarantee the 500 cap is reached regardless of what earlier
    // tests in this file already pushed — the buffer is bounded on every single push.
    expect(_getBufferLengthForTests()).toBe(500);
    expect(getRecentOperations({ ticketId: firstMarker })).toEqual([]);
    expect(getRecentOperations({ ticketId: lastMarker })).toHaveLength(1);
  });
});

describe('installOperationTelemetry (git-exec sink wiring)', () => {
  it('adapts a completed git-exec operation into a matching OperationEvent', async () => {
    installOperationTelemetry();
    try {
      const marker = `git-adapter-${Date.now()}-${Math.random()}`;
      await runHardened(NODE, ['-e', `process.stdout.write('${marker}')`], { timeoutMs: 5_000 });

      // NODE stands in for 'git' (see git-exec.test.ts) so at runtime `kind` is really the node.exe
      // path, not the literal 'git' — don't filter on kind, just find the event by its cmd.
      const recent = getRecentOperations({ limit: 500 }).find((e) => e.cmd.includes(marker));
      expect(recent).toBeDefined();
      expect(recent!.outcome).toBe('ok');
      expect(recent!.endedAt).toBe(recent!.startedAt + recent!.durationMs);
      // git/gh events carry no caller-context attribution (GitExecOptions isn't extended — FLUX-1005).
      expect(recent!.ticketId).toBeUndefined();
    } finally {
      stopOperationTelemetry();
    }
  });

  it('adapts a timed-out git-exec operation with outcome "timeout"', async () => {
    installOperationTelemetry();
    try {
      await expect(
        runHardened(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
      ).rejects.toThrow(/timed out/i);

      // The most recently emitted op must be the timeout we just triggered (see comment above on
      // why this doesn't filter by kind).
      const recent = getRecentOperations({ limit: 1 })[0];
      expect(recent?.outcome).toBe('timeout');
      expect(recent?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      stopOperationTelemetry();
    }
  });

  it('is idempotent — a second install() call does not double-register the sink (FLUX-1164)', async () => {
    installOperationTelemetry();
    installOperationTelemetry();
    try {
      const marker = `double-install-${Date.now()}-${Math.random()}`;
      await runHardened(NODE, ['-e', `process.stdout.write('${marker}')`], { timeoutMs: 5_000 });

      const matches = getRecentOperations({ limit: 500 }).filter((e) => e.cmd.includes(marker));
      expect(matches).toHaveLength(1);
    } finally {
      stopOperationTelemetry();
    }
  });
});
