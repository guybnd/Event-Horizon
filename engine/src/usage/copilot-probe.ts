import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderUsage, UsageGauge } from './types.js';
import { finalizeGauge } from './freshness.js';

// FLUX-1747: measured against real ~/.copilot/session-state — only 1 of 30 session dirs'
// events.jsonl carries `quotaSnapshots`, ranking 27th-of-30 by mtime, with its last occurrence
// ~493KB before EOF. Copilot writes quota at session setup, not per turn, so this is NOT a
// tail-scan problem — it's a "search by content across files" problem. The walk below is
// deliberately UNBOUNDED in file count; any cap below the real directory size reintroduces the
// exact bug this probe exists to fix.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // skip (never abort the walk for) an over-cap file

interface CopilotSnapshotWindow {
  entitlementRequests?: number;
  usedRequests?: number;
  remainingPercentage?: number;
  overage?: number;
  resetDate?: string;
  isUnlimitedEntitlement?: boolean;
}

// A real event line is `{"type":...,"data":{...,"quotaSnapshots":{...}},"id":...,"timestamp":...,
// "parentId":...}` — `quotaSnapshots` lives under `data`, not at the line's top level. The
// top-level fallback is kept for forward/backward format tolerance, not because any real line has
// been observed to use it.
interface CopilotEventLine {
  timestamp?: string;
  quotaSnapshots?: Record<string, CopilotSnapshotWindow>;
  data?: { quotaSnapshots?: Record<string, CopilotSnapshotWindow> };
}

interface FileScanResult {
  snapshot: Record<string, CopilotSnapshotWindow> | undefined;
  timestamp: string | undefined;
}

// Per-file memo keyed on (path, mtimeMs, size) — INCLUDING negative entries ("scanned, no
// quotaSnapshots"). Only one file in ~30 has a snapshot and Copilot appends to events.jsonl
// continuously, so without this a repeat probe (e.g. from the watcher) re-reads ~26 whole files
// on every tick. Keyed per-path so a superseded (stale mtime/size) entry for the same file is
// evicted on insert — an actively-appended file would otherwise leak one new entry per tick
// forever, since its (mtime, size) key never repeats.
const scanMemo = new Map<string, FileScanResult>();
const memoKeyByPath = new Map<string, string>();

function memoKey(filePath: string, mtimeMs: number, size: number): string {
  return `${filePath}::${mtimeMs}::${size}`;
}

function setMemo(filePath: string, key: string, result: FileScanResult): void {
  const priorKey = memoKeyByPath.get(filePath);
  if (priorKey && priorKey !== key) scanMemo.delete(priorKey);
  memoKeyByPath.set(filePath, key);
  scanMemo.set(key, result);
}

function scanFileForQuotaSnapshot(filePath: string, stat: fs.Stats): FileScanResult {
  const key = memoKey(filePath, stat.mtimeMs, stat.size);
  const cached = scanMemo.get(key);
  if (cached) return cached;

  let snapshot: Record<string, CopilotSnapshotWindow> | undefined;
  let timestamp: string | undefined;
  if (stat.size <= MAX_FILE_BYTES) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line || !line.includes('quotaSnapshots')) continue;
        try {
          const parsed = JSON.parse(line) as CopilotEventLine;
          const found = parsed.data?.quotaSnapshots ?? parsed.quotaSnapshots;
          if (found) {
            snapshot = found;
            timestamp = parsed.timestamp;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
      snapshot = undefined;
    }
  }
  const result: FileScanResult = { snapshot, timestamp };
  setMemo(filePath, key, result);
  return result;
}

function listEventFilesNewestFirst(root: string): Array<{ path: string; stat: fs.Stats }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ path: string; stat: fs.Stats }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const eventsPath = path.join(root, entry.name, 'events.jsonl');
    try {
      files.push({ path: eventsPath, stat: fs.statSync(eventsPath) });
    } catch {
      continue;
    }
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files;
}

/** Normalises a resetDate like `"2026-10-01T00:00:00Z"` (no milliseconds) to the canonical ISO-UTC
 *  form `types.ts` promises. Falls back to the raw value if it doesn't parse as a date. */
function normalizeResetsAt(resetDate: string | undefined): string | undefined {
  if (!resetDate) return undefined;
  const ms = Date.parse(resetDate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : resetDate;
}

export function probeCopilotUsage(sessionStateRoot = path.join(os.homedir(), '.copilot', 'session-state')): ProviderUsage {
  try {
    const files = listEventFilesNewestFirst(sessionStateRoot);
    for (const file of files) {
      const { snapshot, timestamp } = scanFileForQuotaSnapshot(file.path, file.stat);
      if (!snapshot) continue;

      // The line's own timestamp is when Copilot observed the value — falls back to the file's
      // mtime, never the probe's own read time (which would make `stale` unreachable, see freshness.ts).
      const observedAt = (timestamp && !Number.isNaN(Date.parse(timestamp)))
        ? timestamp
        : new Date(file.stat.mtimeMs).toISOString();

      const ageMs = Date.now() - file.stat.mtimeMs;
      const gauges: UsageGauge[] = [];
      for (const [key, window] of Object.entries(snapshot)) {
        if (!window) continue;
        gauges.push(finalizeGauge({
          id: `copilot-${key}`,
          label: key,
          unit: 'requests',
          used: window.usedRequests,
          limit: window.entitlementRequests,
          resetsAt: normalizeResetsAt(window.resetDate),
          observedAt,
          provenance: 'exact',
          unlimited: window.isUnlimitedEntitlement || undefined,
          source: { path: file.path, ageMs },
        }));
      }
      if (gauges.length > 0) {
        return { provider: 'copilot', gauges, provenance: 'exact', history: [] };
      }
    }
    return {
      provider: 'copilot',
      gauges: [],
      provenance: 'unknown',
      reason: `no quotaSnapshots found in ${files.length} session files`,
      history: [],
    };
  } catch (err) {
    return {
      provider: 'copilot',
      gauges: [],
      provenance: 'unknown',
      reason: `copilot probe failed: ${err instanceof Error ? err.message : String(err)}`,
      history: [],
    };
  }
}

/** Test-only: clears the module-level scan memo so fixtures don't leak state across test cases. */
export function __resetCopilotScanMemoForTest(): void {
  scanMemo.clear();
  memoKeyByPath.clear();
}

/** Test-only: number of entries in the scan memo, to assert eviction actually caps its size. */
export function __copilotScanMemoSizeForTest(): number {
  return scanMemo.size;
}
