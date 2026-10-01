import path from 'node:path';
import os from 'node:os';
import chokidar from 'chokidar';
import { broadcastToAllWorkspaces } from '../events.js';
import { computeClaudeFloorUsage } from '../agents/claude-floor.js';
import type { CliFramework } from '../agents/types.js';
import { probeCodexUsage } from './codex-probe.js';
import { probeCopilotUsage } from './copilot-probe.js';
import type { ProviderUsage, UsageSnapshot } from './types.js';

// Providers with no local capacity-probe source (FLUX-1747 step 6) — listed, never dropped, so
// FLUX-1748 can render a row for every known framework instead of silently omitting some.
const UNPROBED_FRAMEWORKS: CliFramework[] = ['gemini', 'grok', 'antigravity'];

export interface UsageProbes {
  claude: () => ProviderUsage;
  codex: () => ProviderUsage;
  copilot: () => ProviderUsage;
}

const defaultProbes: UsageProbes = {
  claude: computeClaudeFloorUsage,
  codex: probeCodexUsage,
  copilot: probeCopilotUsage,
};

// FLUX-1747 step 7: 24h in-memory history ring per provider, bucketed to 5-minute resolution, for
// FLUX-1748's sparkline. NOT persisted — an engine restart clears it, which is intentional for v1
// (see docs). getUsageSnapshot runs far more often than every 5 minutes (every debounced watcher
// tick, every 30s poll, every GET /api/usage) — bucketing per gaugeId is what keeps the ring at the
// intended ~288 entries/gauge/day instead of growing unbounded with call frequency.
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_BUCKET_MS = 5 * 60 * 1000;
const historyByProvider = new Map<CliFramework, Array<{ at: string; gaugeId: string; value: number }>>();

function recordHistory(provider: CliFramework, providerUsage: ProviderUsage, nowMs: number): void {
  const entries = historyByProvider.get(provider) ?? [];
  const at = new Date(nowMs).toISOString();
  for (const gauge of providerUsage.gauges) {
    const value = gauge.percent ?? gauge.used;
    if (value == null) continue;
    const lastForGauge = [...entries].reverse().find((entry) => entry.gaugeId === gauge.id);
    if (lastForGauge && nowMs - Date.parse(lastForGauge.at) < HISTORY_BUCKET_MS) continue;
    entries.push({ at, gaugeId: gauge.id, value });
  }
  const cutoffMs = nowMs - HISTORY_WINDOW_MS;
  historyByProvider.set(provider, entries.filter((entry) => Date.parse(entry.at) >= cutoffMs));
}

function withFailSoft(provider: CliFramework, probe: () => ProviderUsage): ProviderUsage {
  try {
    return probe();
  } catch (err) {
    // Per-probe try/catch (step 7): a throw or unparseable source degrades only THIS provider —
    // it must never take the other providers, or the whole endpoint, down with it.
    return {
      provider,
      gauges: [],
      provenance: 'unknown',
      reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
      history: [],
    };
  }
}

// Codex's newestRollout walk and Copilot's directory listing both statSync every file in their
// respective trees on every call — hundreds of files each, growing monotonically, synchronously on
// the shared Express event loop. GET /api/usage carries no auth/rate-limit, and EH's own Codex
// child sessions write into ~/.codex/sessions on every turn, so the chokidar watcher's 500ms
// debounce can otherwise trigger a full re-walk near-continuously during a Furnace burn. A short
// TTL caps that at one real scan per window regardless of how many callers ask in that window.
const SNAPSHOT_TTL_MS = 4000;
let cachedSnapshot: UsageSnapshot | undefined;
let cachedAtMs = 0;

/**
 * Returns the combined snapshot from all three probes, cached for SNAPSHOT_TTL_MS on the
 * production (default-probes) path — callers that pass explicit `probes` (tests) always get a
 * fresh compute, uncached.
 */
export function getUsageSnapshot(probes: UsageProbes = defaultProbes): UsageSnapshot {
  const nowMs = Date.now();
  const useCache = probes === defaultProbes;
  if (useCache && cachedSnapshot && nowMs - cachedAtMs < SNAPSHOT_TTL_MS) {
    return cachedSnapshot;
  }

  const providers: ProviderUsage[] = [
    withFailSoft('claude', probes.claude),
    withFailSoft('codex', probes.codex),
    withFailSoft('copilot', probes.copilot),
    ...UNPROBED_FRAMEWORKS.map((provider): ProviderUsage => ({
      provider,
      gauges: [],
      provenance: 'unknown',
      reason: 'no local capacity probe for this provider',
      history: [],
    })),
  ];

  for (const providerUsage of providers) {
    recordHistory(providerUsage.provider, providerUsage, nowMs);
    providerUsage.history = historyByProvider.get(providerUsage.provider) ?? [];
  }

  const snapshot: UsageSnapshot = { providers, generatedAt: new Date(nowMs).toISOString() };
  if (useCache) {
    cachedSnapshot = snapshot;
    cachedAtMs = nowMs;
  }
  return snapshot;
}

// Fields that legitimately change on every call regardless of real state (timestamps, file age) are
// excluded from the compare — otherwise deep-compare would never consider two reads "equal" and
// usageChanged would fire on every tick.
function snapshotComparisonKey(snapshot: UsageSnapshot): string {
  return JSON.stringify(snapshot.providers.map((p) => ({
    provider: p.provider,
    provenance: p.provenance,
    reason: p.reason,
    planType: p.planType,
    credits: p.credits,
    lastWall: p.lastWall ? { rateLimitType: p.lastWall.rateLimitType, resetsAt: p.lastWall.resetsAt } : undefined,
    gauges: p.gauges.map((g) => ({
      id: g.id,
      used: g.used,
      limit: g.limit,
      percent: g.percent,
      percentFloor: g.percentFloor,
      resetsAt: g.resetsAt,
      windowMinutes: g.windowMinutes,
      provenance: g.provenance,
      freshness: g.freshness,
    })),
  })));
}

let lastBroadcastKey: string | undefined;

/**
 * Deep-compares `snapshot` against the last one broadcast and, on a real change (including a
 * freshness transition like live -> expired with no underlying file change), calls `broadcast`
 * with `usageChanged`. Returns whether it broadcast, for tests.
 */
export function checkAndBroadcast(
  snapshot: UsageSnapshot,
  broadcast: (event: string, data: unknown) => void = broadcastToAllWorkspaces,
): boolean {
  const key = snapshotComparisonKey(snapshot);
  if (key === lastBroadcastKey) return false;
  lastBroadcastKey = key;
  broadcast('usageChanged', { generatedAt: snapshot.generatedAt });
  return true;
}

export function resetUsageBroadcastStateForTest(): void {
  lastBroadcastKey = undefined;
  historyByProvider.clear();
  cachedSnapshot = undefined;
  cachedAtMs = 0;
}

const DEBOUNCE_MS = 500;
const POLL_MS = 30_000;

let debounceTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let watchersStarted = false;

function scheduleCheck(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => checkAndBroadcast(getUsageSnapshot()), DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/**
 * Wires chokidar watchers on the provider source roots plus a 30s poll ceiling (step 7) — the
 * poll exists because a freshness transition (e.g. a Codex window rolling over from live to
 * expired) can happen with NO file change at all, and only a time-driven recheck catches it.
 * Idempotent; process-level (not workspace-scoped), so this is started once at boot.
 */
export function startUsageWatchers(): void {
  if (watchersStarted) return;
  watchersStarted = true;

  const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
  const copilotRoot = path.join(os.homedir(), '.copilot', 'session-state');

  // depth:3 relative to ~/.codex/sessions — real rollouts sit at sessions/2026/08/31/rollout-*.jsonl
  // (year/month/day = 3 levels below sessions/). A lower cap would watch nothing and fail silently.
  chokidar
    .watch(codexRoot, { depth: 3, ignoreInitial: true, persistent: true })
    .on('add', scheduleCheck)
    .on('change', scheduleCheck)
    .on('unlink', scheduleCheck)
    .on('error', () => {});

  chokidar
    .watch(copilotRoot, { depth: 1, ignoreInitial: true, persistent: true })
    .on('add', scheduleCheck)
    .on('change', scheduleCheck)
    .on('unlink', scheduleCheck)
    .on('error', () => {});

  pollTimer = setInterval(() => checkAndBroadcast(getUsageSnapshot()), POLL_MS);
  pollTimer.unref?.();
}
