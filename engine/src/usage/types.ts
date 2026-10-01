import type { CliFramework } from '../agents/types.js';

// FLUX-1747: the normalised capacity-usage wire contract FLUX-1748 consumes.

export type Provenance = 'exact' | 'floor' | 'unknown';
export type Freshness = 'live' | 'stale' | 'expired';

export interface UsageGauge {
  id: string;
  label: string;
  windowMinutes?: number | undefined;
  unit: 'tokens' | 'requests';
  used?: number | undefined;
  limit?: number | undefined;
  percent?: number | undefined;
  percentFloor?: number | undefined;
  /** Copilot-only: `isUnlimitedEntitlement` from the real quota snapshot — when true, `used`/`limit`
   *  describe a non-binding count, not a fraction FLUX-1748 should render as a used/limit bar. */
  unlimited?: boolean | undefined;
  /** Always ISO 8601 UTC — each probe normalises its provider's native format (Codex sends epoch
   *  seconds; Copilot's `resetDate` is already ISO). */
  resetsAt?: string | undefined;
  observedAt: string;
  provenance: Provenance;
  freshness: Freshness;
  source?: { path: string; ageMs: number } | undefined;
}

export interface ProviderUsage {
  provider: CliFramework;
  account?: string | undefined;
  gauges: UsageGauge[];
  provenance: Provenance;
  reason?: string | undefined;
  lastWall?: { rateLimitType?: string | undefined; observedAt: string; resetsAt?: string | undefined } | undefined;
  history: Array<{ at: string; gaugeId: string; value: number }>;
  /** Codex-only: `plan_type` from the real `rate_limits` payload — cheaper to capture now than a
   *  follow-up ticket (not in the original wire-contract block; added per step 4). */
  planType?: string | undefined;
  /** Codex-only: `credits{has_credits,unlimited,balance}` from the real `rate_limits` payload. */
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | undefined } | undefined;
}

export interface UsageSnapshot {
  providers: ProviderUsage[];
  generatedAt: string;
}
