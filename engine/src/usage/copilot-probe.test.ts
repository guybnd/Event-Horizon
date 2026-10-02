import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { probeCopilotUsage, __resetCopilotScanMemoForTest, __copilotScanMemoSizeForTest } from './copilot-probe.js';

// See codex-probe.test.ts's matching comment on why this uses a plain temp dir.
function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSession(root: string, name: string, content: string, mtimeMs: number): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, content);
  const mtime = new Date(mtimeMs);
  fs.utimesSync(file, mtime, mtime);
}

// FLUX-1747 (post-review): real Copilot event lines nest quotaSnapshots under `data`, not at the
// line's top level — `{"type":...,"data":{"quotaSnapshots":{...}},...,"timestamp":...}`. Every
// fixture below uses that nesting; the fix in copilot-probe.ts is
// `parsed.data?.quotaSnapshots ?? parsed.quotaSnapshots`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_SHAPE_LINE = fs.readFileSync(path.join(__dirname, '__fixtures__', 'copilot-event-line.json'), 'utf8').trim();

const QUOTA_LINE = JSON.stringify({
  type: 'quota_snapshot',
  data: {
    quotaSnapshots: {
      chat: { entitlementRequests: 200, usedRequests: 5, remainingPercentage: 97.6, overage: 0, resetDate: '2999-01-01T00:00:00Z' },
    },
  },
  timestamp: new Date().toISOString(),
});

const FILLER_LINE = JSON.stringify({ type: 'noise', payload: 'x'.repeat(200) });

describe('probeCopilotUsage', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('eh-copilot-probe-test');
    __resetCopilotScanMemoForTest();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses quotaSnapshots from data.quotaSnapshots — the real Copilot event nesting, not a top-level field', () => {
    writeSession(root, 'session-1', REAL_SHAPE_LINE + '\n', Date.now());

    const usage = probeCopilotUsage(root);
    expect(usage.provenance).toBe('exact');
    expect(usage.gauges).toHaveLength(1);
    const gauge = usage.gauges[0]!;
    expect(gauge.id).toBe('copilot-chat');
    expect(gauge.used).toBe(5);
    expect(gauge.limit).toBe(200);
    expect(gauge.unlimited).toBeUndefined();
    // resetDate in the fixture has no milliseconds ("...06Z") — normalizeResetsAt must still
    // produce the canonical ISO-UTC form types.ts promises.
    expect(gauge.resetsAt).toBe('2999-01-01T00:00:00.000Z');
    expect(gauge.observedAt).toBe('2026-08-31T12:36:06.431Z');
  });

  it('finds the snapshot at the measured real geometry: 30 files, only the 27th-newest carries quotaSnapshots, far from EOF; an over-cap file among the newest is skipped without aborting the walk', () => {
    const baseMs = Date.now();
    // Ranks 1 (newest) .. 30 (oldest), one second apart.
    for (let rank = 1; rank <= 30; rank++) {
      const mtimeMs = baseMs - rank * 1000;
      if (rank === 4) {
        // Over-cap (>5MB) file among the newest — must be skipped, not abort the walk.
        writeSession(root, `session-${rank}`, 'x'.repeat(5 * 1024 * 1024 + 1024), mtimeMs);
      } else if (rank === 27) {
        // The one real quota-bearing file: two occurrences, the last far before EOF.
        const lines = [
          ...Array.from({ length: 20 }, () => FILLER_LINE),
          QUOTA_LINE,
          ...Array.from({ length: 30 }, () => FILLER_LINE),
          QUOTA_LINE,
          ...Array.from({ length: 500 }, () => FILLER_LINE), // pads well past the last occurrence, before EOF
        ];
        writeSession(root, `session-${rank}`, lines.join('\n') + '\n', mtimeMs);
      } else {
        writeSession(root, `session-${rank}`, [FILLER_LINE, FILLER_LINE].join('\n') + '\n', mtimeMs);
      }
    }

    const usage = probeCopilotUsage(root);
    expect(usage.provenance).toBe('exact');
    expect(usage.gauges).toHaveLength(1);
    const gauge = usage.gauges[0]!;
    expect(gauge.id).toBe('copilot-chat');
    expect(gauge.used).toBe(5);
    expect(gauge.limit).toBe(200);
    expect(gauge.resetsAt).toBe('2999-01-01T00:00:00.000Z');
    expect(gauge.source?.path).toContain('session-27');
  });

  it('returns unknown with the file count in the reason when no file carries quotaSnapshots', () => {
    const baseMs = Date.now();
    for (let rank = 1; rank <= 5; rank++) {
      writeSession(root, `session-${rank}`, FILLER_LINE + '\n', baseMs - rank * 1000);
    }
    const usage = probeCopilotUsage(root);
    expect(usage.provenance).toBe('unknown');
    expect(usage.gauges).toHaveLength(0);
    expect(usage.reason).toBe('no quotaSnapshots found in 5 session files');
  });

  it('memoizes a scanned file by (path, mtimeMs, size) — an unchanged file is not re-read', () => {
    // FLUX-1800: a whole-second mtime survives the stat → Date → utimes round-trip exactly on every
    // filesystem; a sub-ms APFS mtime didn't, so on macOS the re-stamp changed the key and the memo missed.
    const mtimeMs = Math.floor(Date.now() / 1000) * 1000;
    writeSession(root, 'session-1', QUOTA_LINE + '\n', mtimeMs);

    const first = probeCopilotUsage(root);
    expect(first.gauges).toHaveLength(1);

    // Mutate the file on disk WITHOUT changing its (mtime, size) signature — if the memo were
    // bypassed, this changed content would be picked up and the gauge would disappear. Same byte
    // length by construction (a fixed-size buffer of non-quota bytes), so only mtime needs re-stamping.
    const filePath = path.join(root, 'session-1', 'events.jsonl');
    const original = fs.statSync(filePath);
    fs.writeFileSync(filePath, Buffer.alloc(original.size, 'a'));
    fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));

    const second = probeCopilotUsage(root);
    expect(second.gauges).toHaveLength(1); // memoized result, not the mutated (quota-less) content
  });

  it('evicts the prior memo entry for a path when the file changes — an actively-appended file does not leak one entry per tick forever', () => {
    let mtimeMs = Date.now();
    writeSession(root, 'session-1', FILLER_LINE + '\n', mtimeMs);
    probeCopilotUsage(root); // seeds one memo entry for this (path, mtime, size)
    expect(__copilotScanMemoSizeForTest()).toBe(1);

    // Simulate repeated appends: new content, new mtime, new size each tick — a genuinely new memo
    // key every time. Without per-path eviction the memo would grow by one entry per call.
    for (let i = 0; i < 5; i++) {
      mtimeMs += 1000;
      writeSession(root, 'session-1', (FILLER_LINE + i).repeat(1) + '\n', mtimeMs);
      probeCopilotUsage(root);
    }
    expect(__copilotScanMemoSizeForTest()).toBe(1); // still just the one (evicted) entry for this path

    // The final append carries the real quota content — proves eviction doesn't also lose the
    // ability to find a snapshot on the newest key.
    mtimeMs += 1000;
    writeSession(root, 'session-1', QUOTA_LINE + '\n', mtimeMs);
    const usage = probeCopilotUsage(root);
    expect(usage.gauges).toHaveLength(1);
    expect(__copilotScanMemoSizeForTest()).toBe(1);
  });
});
