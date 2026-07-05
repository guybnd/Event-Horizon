/**
 * Client-side perf instrumentation (FLUX-1133). Dependency-free singleton, mirroring the shape
 * of the engine's `perf/registry.ts` (FLUX-1129) so both sides read the same way — counters +
 * histograms with p50/p95. Always on (a few KB of state); only the dev-console warnings are
 * gated on `import.meta.env.DEV`.
 *
 * Attached to `window.__ehPerf` so a lag episode can be diagnosed live: open the console and run
 * `__ehPerf.snapshot()` to see whether the client is drowning in SSE-triggered refreshes or
 * waiting on slow API calls.
 */

/** Upper bound (ms) of each histogram bucket; the last is an unbounded overflow bucket. */
const BUCKET_BOUNDARIES_MS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];

/** A `recordDuration` above this is kept in the slow-event ring buffer and warned on in dev. */
const SLOW_DURATION_MS = 300;
const MAX_SLOW_EVENTS = 100;

/** SSE burst detection: warn (in dev, at most once per window) when events land faster than this. */
const SSE_BURST_WINDOW_MS = 5000;
const SSE_BURST_THRESHOLD = 30;

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

export interface SlowEvent {
  name: string;
  ms: number;
  at: number;
}

export interface PerfSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  slowEvents: SlowEvent[];
  /** ms since this module loaded (i.e. since the portal tab opened). */
  uptimeMs: number;
}

const startedAt = Date.now();
const counters = new Map<string, number>();
const histograms = new Map<string, Histogram>();
let slowEvents: SlowEvent[] = [];
let sseEventTimestamps: number[] = [];
let lastSseBurstWarnAt = -Infinity;

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

  if (ms > SLOW_DURATION_MS) {
    slowEvents.push({ name, ms, at: Date.now() });
    if (slowEvents.length > MAX_SLOW_EVENTS) slowEvents.shift();
    if (import.meta.env.DEV) {
      console.warn(`[perf] slow ${name}: ${ms.toFixed(0)}ms`);
    }
  }
}

/** Counts an SSE event by type and watches for bursts (a storm of refresh-triggering traffic). */
export function recordSseEvent(type: string): void {
  incr(`sse.event.${type}`);

  const now = Date.now();
  sseEventTimestamps.push(now);
  const cutoff = now - SSE_BURST_WINDOW_MS;
  while (sseEventTimestamps.length > 0 && sseEventTimestamps[0]! < cutoff) sseEventTimestamps.shift();

  if (
    import.meta.env.DEV &&
    sseEventTimestamps.length > SSE_BURST_THRESHOLD &&
    now - lastSseBurstWarnAt > SSE_BURST_WINDOW_MS
  ) {
    lastSseBurstWarnAt = now;
    console.warn(`[perf] SSE burst: ${sseEventTimestamps.length} events/${SSE_BURST_WINDOW_MS / 1000}s`);
  }
}

/**
 * Estimates the `p`th percentile as the upper boundary of the bucket that contains the target
 * rank — a coarse but allocation-free approximation given only bucket counts (no raw samples are
 * retained). The overflow bucket's boundary is +Infinity, which isn't a useful estimate, so that
 * case falls back to the observed max.
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

export function snapshot(): PerfSnapshot {
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
    slowEvents: [...slowEvents],
    uptimeMs: Date.now() - startedAt,
  };
}

/** Clears all state — test isolation only, never called from production code paths. */
export function resetForTest(): void {
  counters.clear();
  histograms.clear();
  slowEvents = [];
  sseEventTimestamps = [];
  lastSseBurstWarnAt = -Infinity;
}

export interface EhPerf {
  snapshot: typeof snapshot;
  recordDuration: typeof recordDuration;
  incr: typeof incr;
}

declare global {
  interface Window {
    __ehPerf?: EhPerf;
  }
}

if (typeof window !== 'undefined') {
  window.__ehPerf = { snapshot, recordDuration, incr };
}
