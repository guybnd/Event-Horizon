import { describe, it, expect, afterEach } from 'vitest';
import { cliSessionsById } from '../session-store.js';
import { computeClaudeFloorUsage } from './claude-floor.js';
import type { CliSessionRecord } from './types.js';

// Minimal fake session record — same technique as claude-code-telemetry-capture.test.ts's
// fakeSession (cast through unknown; only the fields this module reads need real values).
function fakeSession(overrides: Partial<CliSessionRecord>): CliSessionRecord {
  return {
    id: 'sess',
    taskId: 'FLUX-x',
    framework: 'claude',
    status: 'running',
    label: 'Test',
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  } as unknown as CliSessionRecord;
}

describe('computeClaudeFloorUsage', () => {
  afterEach(() => {
    cliSessionsById.clear();
  });

  it('sums inputTokens+outputTokens across claude sessions only, with provenance floor and no percentFloor', () => {
    cliSessionsById.set('a', fakeSession({ id: 'a', framework: 'claude', inputTokens: 100, outputTokens: 50 }));
    cliSessionsById.set('b', fakeSession({ id: 'b', framework: 'claude', inputTokens: 10, outputTokens: 5 }));
    cliSessionsById.set('c', fakeSession({ id: 'c', framework: 'codex', inputTokens: 9999, outputTokens: 9999 }));

    const usage = computeClaudeFloorUsage();
    expect(usage.provider).toBe('claude');
    expect(usage.provenance).toBe('floor');
    expect(usage.gauges).toHaveLength(1);
    const gauge = usage.gauges[0]!;
    expect(gauge.used).toBe(165);
    expect(gauge.percentFloor).toBeUndefined();
    expect(gauge.provenance).toBe('floor');
  });

  it('the fallback gauge is freshness:live with windowMinutes and resetsAt both omitted', () => {
    cliSessionsById.set('a', fakeSession({ id: 'a', framework: 'claude' }));
    const gauge = computeClaudeFloorUsage().gauges[0]!;
    expect(gauge.freshness).toBe('live');
    expect(gauge.windowMinutes).toBeUndefined();
    expect(gauge.resetsAt).toBeUndefined();
  });

  it('lastWall reflects the most recently observed lastRateLimit across claude sessions', () => {
    cliSessionsById.set('a', fakeSession({
      id: 'a',
      framework: 'claude',
      lastRateLimit: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: '2026-09-05T00:00:00.000Z', observedAt: '2026-09-04T20:00:00.000Z' },
    }));
    cliSessionsById.set('b', fakeSession({
      id: 'b',
      framework: 'claude',
      lastRateLimit: { status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: '2026-09-10T00:00:00.000Z', observedAt: '2026-09-04T23:00:00.000Z' },
    }));

    const usage = computeClaudeFloorUsage();
    expect(usage.lastWall?.rateLimitType).toBe('seven_day'); // the later observedAt wins
  });

  it('returns a zero-used gauge (not unknown) when no claude sessions are live', () => {
    const usage = computeClaudeFloorUsage();
    expect(usage.gauges[0]!.used).toBe(0);
    expect(usage.provenance).toBe('floor');
  });
});
