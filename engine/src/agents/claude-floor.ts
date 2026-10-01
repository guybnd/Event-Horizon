import { cliSessionsById } from '../session-store.js';
import type { ProviderUsage, UsageGauge } from '../usage/types.js';
import { finalizeGauge } from '../usage/freshness.js';

// FLUX-1747: sited under agents/ (the sanctioned per-CLI home, check-adapter-boundary.mjs) so
// engine/src/usage/ stays free of any Claude-specific literal. `getAllSessionsForTask` is per-task
// and cannot serve this — this aggregates across the process-wide `cliSessionsById` map directly.
//
// `used` is a TRUE FLOOR: local counting can only miss usage (other terminals, boards, and the
// desktop app draining the same quota), never invent it. There is no derivable window start for a
// 5-hour rolling window with no server anchor, so this never invents one — the gauge is "tokens EH
// has observed since engine start", carrying NEITHER `windowMinutes` NOR `resetsAt`. That absence is
// itself the "not aligned to any window" signal (distinct from `freshness`, which only ever means
// "the observation is old") — a counter incremented right now has zero age, so it is `freshness:
// 'live'`, never 'stale'. FLUX-1748 renders it as "since <observedAt>" rather than naming a window.
export function computeClaudeFloorUsage(): ProviderUsage {
  const observedAt = new Date().toISOString();
  let used = 0;
  let lastWall: ProviderUsage['lastWall'];
  let lastWallObservedAtMs = Number.NEGATIVE_INFINITY;

  for (const session of cliSessionsById.values()) {
    if (session.framework !== 'claude') continue;
    used += (session.inputTokens ?? 0) + (session.outputTokens ?? 0);

    const wall = session.lastRateLimit;
    if (!wall) continue;
    const observedAtMs = Date.parse(wall.observedAt);
    if (Number.isFinite(observedAtMs) && observedAtMs > lastWallObservedAtMs) {
      lastWallObservedAtMs = observedAtMs;
      lastWall = { rateLimitType: wall.rateLimitType, observedAt: wall.observedAt, resetsAt: wall.resetsAt };
    }
  }

  const gauge: UsageGauge = finalizeGauge({
    id: 'claude-floor',
    label: 'since engine start',
    unit: 'tokens',
    used,
    observedAt,
    provenance: 'floor',
  });

  return { provider: 'claude', gauges: [gauge], provenance: 'floor', lastWall, history: [] };
}
