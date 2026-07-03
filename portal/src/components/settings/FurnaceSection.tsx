interface FurnaceSectionProps {
  /** Rate-limit auto-retry cadence, in milliseconds (FLUX-1063). */
  rateLimitRetryIntervalMs: number;
  setRateLimitRetryIntervalMs: (v: number) => void;
  /** Rate-limit cooldown ceiling, in milliseconds (FLUX-1063). */
  rateLimitMaxWaitMs: number;
  setRateLimitMaxWaitMs: (v: number) => void;
}

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * FLUX-1063: global defaults for the Furnace rate-limit cooldown. When a burn session dies from a
 * transient usage/rate limit, the ticket cools down and auto-retries on this cadence up to the ceiling
 * before failing outright. Stored in ms; edited here in minutes / hours for legibility. New batches
 * inherit these; a batch can override them via `furnace_update`.
 */
export function FurnaceSection({
  rateLimitRetryIntervalMs,
  setRateLimitRetryIntervalMs,
  rateLimitMaxWaitMs,
  setRateLimitMaxWaitMs,
}: FurnaceSectionProps) {
  const retryMinutes = Math.max(1, Math.round(rateLimitRetryIntervalMs / MIN_MS));
  const maxWaitHours = Math.max(1, Math.round((rateLimitMaxWaitMs / HOUR_MS) * 10) / 10);
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
      <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Furnace Rate-Limit Cooldown</h3>
      <p className="text-xs text-gray-500 mb-5">
        When a Furnace burn hits a usage/rate limit (e.g. the 5-hour session limit), the ticket cools down
        and auto-retries instead of being parked. New batches inherit these defaults.
      </p>

      <div className="flex flex-wrap gap-6">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Retry every</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={retryMinutes}
              onChange={(e) => setRateLimitRetryIntervalMs(Math.max(1, parseInt(e.target.value, 10) || 1) * MIN_MS)}
              className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-black/20"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">minutes</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">How often a cooling-down ticket retries (default 20m).</p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Give up after</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={0.5}
              value={maxWaitHours}
              onChange={(e) => setRateLimitMaxWaitMs(Math.max(1, parseFloat(e.target.value) || 1) * HOUR_MS)}
              className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-black/20"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">hours</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">Ceiling before a still-limited ticket fails outright (default 5h).</p>
        </div>
      </div>
    </div>
  );
}
