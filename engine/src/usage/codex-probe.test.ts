import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { probeCodexUsage } from './codex-probe.js';

// A unique, plain directory under os.tmpdir() (not the classify-tests.mjs-flagged temp-dir API)
// keeps this test in the fast `unit` tier.
function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRollout(root: string, relPath: string, lines: string[], mtime?: Date): string {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.map((l) => l + '\n').join(''));
  if (mtime) fs.utimesSync(full, mtime, mtime);
  return full;
}

// FLUX-1747 (post-review): real Codex rollout lines nest rate_limits under `payload`, not at the
// line's top level — `{"timestamp":...,"payload":{"rate_limits":{...}}}`. Every fixture below uses
// that nesting; the fix in codex-probe.ts is `parsed.payload?.rate_limits ?? parsed.rate_limits`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_SHAPE_LINE = fs.readFileSync(path.join(__dirname, '__fixtures__', 'codex-rollout-line.json'), 'utf8').trim();

describe('probeCodexUsage', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('eh-codex-probe-test');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses rate_limits from payload.rate_limits — the real Codex rollout nesting, not a top-level field', () => {
    writeRollout(root, '2026/08/31/rollout-2026-08-31T12-36-06-abc.jsonl', [REAL_SHAPE_LINE]);

    const usage = probeCodexUsage(root);
    expect(usage.provider).toBe('codex');
    expect(usage.provenance).toBe('exact');
    expect(usage.gauges).toHaveLength(2);

    const primary = usage.gauges.find((g) => g.id === 'codex-primary')!;
    const secondary = usage.gauges.find((g) => g.id === 'codex-secondary')!;
    // resets_at is 9999999999 (far future) in the fixture, so neither gauge is expired and both
    // retain their percent — this assertion only depends on the nesting being read correctly, not
    // on when the test happens to run.
    expect(primary.percent).toBe(42.5);
    expect(secondary.percent).toBe(8.0);
    expect(primary.resetsAt).toBe(new Date(9999999999 * 1000).toISOString());

    expect(usage.lastWall).toBeUndefined(); // rate_limit_reached_type is null in the fixture
    expect(usage.planType).toBe('plus');
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: '25.00' });
  });

  it('reads the newest rollout and yields two gauges, one expired one live from the same line', () => {
    // Mixed real-shaped case: primary.resets_at in the past, secondary.resets_at ~57h future, both
    // computed relative to Date.now() so this never becomes a time bomb. The line's own `timestamp`
    // is "now", so `observedAt` is fresh and the live/expired split is driven only by resets_at.
    const nowSec = Math.floor(Date.now() / 1000);
    const primaryResetsAt = nowSec - Math.round(4.4 * 24 * 3600); // 4.4 days in the past
    const secondaryResetsAt = nowSec + 57 * 3600; // 57h in the future
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 90.0, window_minutes: 300, resets_at: primaryResetsAt },
          secondary: { used_percent: 14.0, window_minutes: 10080, resets_at: secondaryResetsAt },
          credits: { has_credits: false, unlimited: false, balance: '0' },
          plan_type: 'plus',
          rate_limit_reached_type: 'primary',
        },
      },
    });
    writeRollout(root, '2026/08/31/rollout-2026-08-31T22-33-44-abc.jsonl', [line]);

    const usage = probeCodexUsage(root);
    expect(usage.provenance).toBe('exact');
    expect(usage.gauges).toHaveLength(2);

    const primary = usage.gauges.find((g) => g.id === 'codex-primary')!;
    const secondary = usage.gauges.find((g) => g.id === 'codex-secondary')!;
    expect(primary.freshness).toBe('expired');
    expect(primary.percent).toBeUndefined(); // dropped per the freshness rule
    expect(primary.resetsAt).toBe(new Date(primaryResetsAt * 1000).toISOString());
    expect(secondary.freshness).toBe('live');
    expect(secondary.percent).toBe(14.0);

    // rate_limit_reached_type is 'primary' — lastWall.resetsAt must name the PRIMARY window, not
    // always primary regardless of which window actually walled (the pre-fix bug).
    expect(usage.lastWall?.rateLimitType).toBe('primary');
    expect(usage.lastWall?.resetsAt).toBe(new Date(primaryResetsAt * 1000).toISOString());
    expect(usage.planType).toBe('plus');
    expect(usage.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });
  });

  it('lastWall.resetsAt names the SECONDARY window when secondary is the one that walled', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const secondaryResetsAt = nowSec + 57 * 3600;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      payload: {
        rate_limits: {
          primary: { used_percent: 10, window_minutes: 300, resets_at: nowSec + 3600 },
          secondary: { used_percent: 99, window_minutes: 10080, resets_at: secondaryResetsAt },
          rate_limit_reached_type: 'secondary',
        },
      },
    });
    writeRollout(root, '2026/08/31/rollout-a.jsonl', [line]);

    const usage = probeCodexUsage(root);
    expect(usage.lastWall?.rateLimitType).toBe('secondary');
    expect(usage.lastWall?.resetsAt).toBe(new Date(secondaryResetsAt * 1000).toISOString());
  });

  it('reports stale freshness when the line timestamp is old, even though resets_at is still in the future', () => {
    // Regression for observedAt being stamped with the probe's own read clock instead of the
    // provider's observation time (which made `stale` unreachable) — the line's `timestamp` is
    // old, so `stale` must fire even though the window itself hasn't rolled over.
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTimestamp = new Date((nowSec - 7 * 24 * 3600) * 1000).toISOString(); // 7 days old
    const line = JSON.stringify({
      timestamp: oldTimestamp,
      payload: {
        rate_limits: {
          primary: { used_percent: 55, window_minutes: 300, resets_at: nowSec + 100 * 24 * 3600 },
        },
      },
    });
    writeRollout(root, '2026/08/31/rollout-a.jsonl', [line]);

    const usage = probeCodexUsage(root);
    const primary = usage.gauges.find((g) => g.id === 'codex-primary')!;
    expect(primary.freshness).toBe('stale');
    expect(primary.percent).toBe(55); // stale retains the value, unlike expired
    expect(primary.observedAt).toBe(oldTimestamp);
  });

  it('picks the newest rollout by mtime across the date-tree, not the lexicographically last', () => {
    writeRollout(root, '2026/08/30/rollout-older.jsonl', [
      JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 9999999999 } } } }),
    ], new Date('2026-08-30T00:00:00Z'));
    writeRollout(root, '2026/08/31/rollout-newer.jsonl', [
      JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 77, window_minutes: 300, resets_at: 9999999999 } } } }),
    ], new Date('2026-08-31T00:00:00Z'));

    const usage = probeCodexUsage(root);
    expect(usage.gauges.find((g) => g.id === 'codex-primary')?.percent).toBe(77);
  });

  it('epoch-seconds resets_at is normalised to ISO 8601', () => {
    writeRollout(root, '2026/08/31/rollout-a.jsonl', [
      JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: 1788200191 } } } }),
    ]);
    const usage = probeCodexUsage(root);
    expect(usage.gauges[0]!.resetsAt).toBe('2026-08-31T18:16:31.000Z');
  });

  it('falls back to the previous valid line when the last line is corrupt', () => {
    writeRollout(root, '2026/08/31/rollout-a.jsonl', [
      JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 9999999999 } } } }),
      '{not valid json, mid-write cut off',
    ]);
    const usage = probeCodexUsage(root);
    expect(usage.gauges.find((g) => g.id === 'codex-primary')?.percent).toBe(42);
  });

  it('returns unknown with a reason when no rollout files exist', () => {
    const usage = probeCodexUsage(root);
    expect(usage.provenance).toBe('unknown');
    expect(usage.gauges).toHaveLength(0);
    expect(usage.reason).toMatch(/no codex rollout files/);
  });

  it('returns unknown with a reason when the newest rollout has no rate_limits line', () => {
    writeRollout(root, '2026/08/31/rollout-a.jsonl', [JSON.stringify({ type: 'system', subtype: 'other' })]);
    const usage = probeCodexUsage(root);
    expect(usage.provenance).toBe('unknown');
    expect(usage.reason).toMatch(/no rate_limits line/);
  });
});
