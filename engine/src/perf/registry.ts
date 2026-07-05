/**
 * In-memory perf metrics registry (FLUX-1129). Dependency-free by design (precedent:
 * `agent-payload-metrics.ts`) — this runs on every API request, so it stays allocation-light
 * and never touches disk or an external process. State is process-lifetime only; there is no
 * persistence and no cross-process aggregation.
 *
 * Sibling tickets under epic FLUX-1128 (event-loop monitor, git timing, task-store counters)
 * feed into this same registry via `incr`/`recordDuration` — keep this API surface minimal
 * and stable.
 */

/** Upper bound (ms) of each histogram bucket; the last is an unbounded overflow bucket. */
const BUCKET_BOUNDARIES_MS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];

interface Histogram {
  count: number;
  sum: number;
  max: number;
  /** Per-bucket counts, indexed in parallel with BUCKET_BOUNDARIES_MS. */
  buckets: number[];
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  max: number;
  p50: number;
  p95: number;
}

export interface RegistrySnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  uptimeSeconds: number;
  rss: number;
}

const counters = new Map<string, number>();
const histograms = new Map<string, Histogram>();

function newHistogram(): Histogram {
  return { count: 0, sum: 0, max: 0, buckets: new Array<number>(BUCKET_BOUNDARIES_MS.length).fill(0) };
}

export function incr(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function recordDuration(name: string, ms: number): void {
  let h = histograms.get(name);
  if (!h) {
    h = newHistogram();
    histograms.set(name, h);
  }
  h.count += 1;
  h.sum += ms;
  if (ms > h.max) h.max = ms;
  const idx = BUCKET_BOUNDARIES_MS.findIndex((boundary) => ms <= boundary);
  const bucketIdx = idx < 0 ? BUCKET_BOUNDARIES_MS.length - 1 : idx;
  h.buckets[bucketIdx] = (h.buckets[bucketIdx] ?? 0) + 1;
}

/**
 * Estimates the `p`th percentile as the upper boundary of the bucket that contains the
 * target rank — a coarse but allocation-free approximation given only bucket counts (no raw
 * samples are retained). The overflow bucket's boundary is +Infinity, which isn't a useful
 * estimate, so that case falls back to the observed max.
 */
function percentile(h: Histogram, p: number): number {
  if (h.count === 0) return 0;
  const targetRank = Math.ceil(h.count * p);
  let cumulative = 0;
  for (let i = 0; i < BUCKET_BOUNDARIES_MS.length; i++) {
    cumulative += h.buckets[i] ?? 0;
    if (cumulative >= targetRank) {
      const boundary = BUCKET_BOUNDARIES_MS[i];
      return boundary !== undefined && Number.isFinite(boundary) ? boundary : h.max;
    }
  }
  return h.max;
}

export function snapshot(): RegistrySnapshot {
  const countersObj: Record<string, number> = {};
  for (const [name, count] of counters) countersObj[name] = count;

  const histogramsObj: Record<string, HistogramSnapshot> = {};
  for (const [name, h] of histograms) {
    histogramsObj[name] = {
      count: h.count,
      sum: h.sum,
      max: h.max,
      p50: percentile(h, 0.5),
      p95: percentile(h, 0.95),
    };
  }

  return {
    counters: countersObj,
    histograms: histogramsObj,
    uptimeSeconds: process.uptime(),
    rss: process.memoryUsage().rss,
  };
}

/** Clears all state — test isolation only, never called from production code paths. */
export function resetForTest(): void {
  counters.clear();
  histograms.clear();
}
