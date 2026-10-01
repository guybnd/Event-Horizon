// FLUX-1746: pure builder tests for `buildCompactionHandoffEntry` (status-transition-service.ts) —
// no I/O, no fixture, no spawn. The two Ready-path wiring tests (MCP change_status and the portal
// PUT) live separately per the ticket's plan, since deleting either `push` must fail a DIFFERENT
// test than this one — this file only covers the shared decision logic both call sites delegate to.
import { describe, it, expect } from 'vitest';
import { buildCompactionHandoffEntry } from './status-transition-service.js';
import type { CliSessionRecord } from './agents/types.js';

function fakeSession(overrides: Partial<CliSessionRecord>): CliSessionRecord {
  return { id: 's', taskId: 'FLUX-1746', ...overrides } as unknown as CliSessionRecord;
}

const NOW = '2026-09-05T12:00:00.000Z';

describe('buildCompactionHandoffEntry (FLUX-1746)', () => {
  it('one compacted implementation session returns an entry naming count and dropped tokens', () => {
    const entry = buildCompactionHandoffEntry(
      [fakeSession({ phase: 'implementation', compactionCount: 2, cumulativeDroppedTokens: 50_000 })],
      NOW,
    );
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe('activity');
    expect(entry!.comment).toContain('compacted 2 times');
    expect(entry!.comment).toContain('50k');
    expect(entry!.date).toBe(NOW);
  });

  it('a fast-path session also counts (not just implementation)', () => {
    const entry = buildCompactionHandoffEntry(
      [fakeSession({ phase: 'fast-path', compactionCount: 1, cumulativeDroppedTokens: 12_000 })],
      NOW,
    );
    expect(entry).not.toBeNull();
    expect(entry!.comment).toContain('compacted 1 time,');
  });

  it('no compacted sessions returns null', () => {
    const entry = buildCompactionHandoffEntry(
      [fakeSession({ phase: 'implementation' }), fakeSession({ phase: 'implementation', compactionCount: 0 })],
      NOW,
    );
    expect(entry).toBeNull();
  });

  it('an empty array (post-restart — no in-memory sessions survived) returns null', () => {
    expect(buildCompactionHandoffEntry([], NOW)).toBeNull();
  });

  it('a compacted REVIEW-phase session does not count', () => {
    const entry = buildCompactionHandoffEntry(
      [fakeSession({ phase: 'review', compactionCount: 3, cumulativeDroppedTokens: 90_000 })],
      NOW,
    );
    expect(entry).toBeNull();
  });

  it('sums across multiple compacted implementation sessions on the same ticket', () => {
    const entry = buildCompactionHandoffEntry(
      [
        fakeSession({ phase: 'implementation', compactionCount: 1, cumulativeDroppedTokens: 10_000 }),
        fakeSession({ phase: 'implementation', compactionCount: 2, cumulativeDroppedTokens: 20_000 }),
        fakeSession({ phase: 'review', compactionCount: 5, cumulativeDroppedTokens: 999_999 }),
      ],
      NOW,
    );
    expect(entry).not.toBeNull();
    expect(entry!.comment).toContain('compacted 3 times');
    expect(entry!.comment).toContain('30k');
  });

  it('a compacted session with no known dropped-token count (post_tokens absent on the wire) omits the dropping clause instead of printing ~0', () => {
    const entry = buildCompactionHandoffEntry(
      [fakeSession({ phase: 'implementation', compactionCount: 1 })],
      NOW,
    );
    expect(entry).not.toBeNull();
    expect(entry!.comment).toContain('compacted 1 time —');
    expect(entry!.comment).not.toContain('dropping');
  });
});
