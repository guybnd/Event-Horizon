import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderUsage, UsageGauge } from './types.js';
import { finalizeGauge } from './freshness.js';

const TAIL_BYTES = 64 * 1024;

interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexRateLimitsPayload {
  limit_id?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string };
  plan_type?: string;
  rate_limit_reached_type?: string | null;
}

// A real rollout line is `{"timestamp":...,"ordinal":...,"type":"event_msg","payload":{"type":
// "token_count","info":{...},"rate_limits":{...}}}` — `rate_limits` lives under `payload`, not at
// the line's top level. The top-level fallback is kept for forward/backward format tolerance, not
// because any real line has been observed to use it.
interface CodexRateLimitsLine {
  timestamp?: string;
  rate_limits?: CodexRateLimitsPayload;
  payload?: { rate_limits?: CodexRateLimitsPayload };
}

interface FoundRateLimits {
  rateLimits: CodexRateLimitsPayload;
  timestamp: string | undefined;
}

function findRolloutFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) results.push(full);
    }
  };
  walk(root);
  return results;
}

function newestRollout(root: string): string | undefined {
  const files = findRolloutFiles(root);
  if (files.length === 0) return undefined;
  let newest = files[0]!;
  let newestMtime = fs.statSync(newest).mtimeMs;
  for (const file of files.slice(1)) {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > newestMtime) {
      newest = file;
      newestMtime = mtime;
    }
  }
  return newest;
}

function readTail(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Scans the tail backwards for the last well-formed line carrying `rate_limits` — a corrupt/
 *  truncated final line (mid-write) falls back to the previous valid one rather than failing.
 *  Also returns that line's own `timestamp` (when the provider observed the value), so callers
 *  don't stamp `observedAt` with the probe's read time instead. */
function lastValidRateLimitsLine(tail: string): FoundRateLimits | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || !line.includes('rate_limits')) continue;
    try {
      const parsed = JSON.parse(line) as CodexRateLimitsLine;
      const rateLimits = parsed.payload?.rate_limits ?? parsed.rate_limits;
      if (rateLimits) return { rateLimits, timestamp: parsed.timestamp };
    } catch {
      continue;
    }
  }
  return undefined;
}

function epochSecondsToIso(sec: number | undefined): string | undefined {
  return typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : undefined;
}

/** Derives a human label from the window length rather than hardcoding per-provider strings. */
function labelForWindow(minutes: number | undefined): string {
  if (minutes == null) return 'window';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export function probeCodexUsage(sessionsRoot = path.join(os.homedir(), '.codex', 'sessions')): ProviderUsage {
  try {
    const newest = newestRollout(sessionsRoot);
    if (!newest) {
      return { provider: 'codex', gauges: [], provenance: 'unknown', reason: 'no codex rollout files found', history: [] };
    }
    const stat = fs.statSync(newest);
    const tail = readTail(newest, TAIL_BYTES);
    const found = lastValidRateLimitsLine(tail);
    if (!found) {
      return { provider: 'codex', gauges: [], provenance: 'unknown', reason: 'no rate_limits line found in newest rollout tail', history: [] };
    }
    const { rateLimits } = found;
    // The line's own timestamp is when the provider observed the value — falls back to the file's
    // mtime, never the probe's own read time (which would make `stale` unreachable, see freshness.ts).
    const observedAt = (found.timestamp && !Number.isNaN(Date.parse(found.timestamp)))
      ? found.timestamp
      : new Date(stat.mtimeMs).toISOString();

    const ageMs = Date.now() - stat.mtimeMs;
    const gauges: UsageGauge[] = [];
    const addWindow = (id: string, window: CodexRateLimitWindow | undefined): void => {
      if (!window) return;
      gauges.push(finalizeGauge({
        id,
        label: labelForWindow(window.window_minutes),
        windowMinutes: window.window_minutes,
        // Codex's rate_limits payload carries only used_percent, no request count — `unit` is
        // nominal here (there is no `used`/`limit` pair to render as a fraction, only `percent`).
        unit: 'requests',
        percent: window.used_percent,
        resetsAt: epochSecondsToIso(window.resets_at),
        observedAt,
        provenance: 'exact',
        source: { path: newest, ageMs },
      }));
    };
    addWindow('codex-primary', rateLimits.primary);
    addWindow('codex-secondary', rateLimits.secondary);

    const wallWindow = rateLimits.rate_limit_reached_type === 'secondary' ? rateLimits.secondary : rateLimits.primary;
    const lastWall = rateLimits.rate_limit_reached_type
      ? {
          rateLimitType: rateLimits.rate_limit_reached_type,
          observedAt,
          resetsAt: epochSecondsToIso(wallWindow?.resets_at),
        }
      : undefined;

    const credits = rateLimits.credits
      ? {
          hasCredits: !!rateLimits.credits.has_credits,
          unlimited: !!rateLimits.credits.unlimited,
          balance: rateLimits.credits.balance,
        }
      : undefined;

    return {
      provider: 'codex',
      gauges,
      provenance: 'exact',
      lastWall,
      planType: rateLimits.plan_type,
      credits,
      history: [],
    };
  } catch (err) {
    return {
      provider: 'codex',
      gauges: [],
      provenance: 'unknown',
      reason: `codex probe failed: ${err instanceof Error ? err.message : String(err)}`,
      history: [],
    };
  }
}
