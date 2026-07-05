/**
 * Event-loop delay monitor (FLUX-1130): samples `perf_hooks.monitorEventLoopDelay()` on a
 * fixed window and feeds the window's p50/p99/max into the FLUX-1129 registry, so a
 * synchronous stall anywhere in the process (blocking git spawn, giant JSON serialize, sync
 * fs rescan, ...) shows up in `GET /api/perf` regardless of which code path caused it.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { recordDuration } from './registry.js';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

const DEFAULT_STALL_MS = 150;
const DEFAULT_WINDOW_MS = 5000;
const NS_PER_MS = 1e6;

/** The subset of Node's `IntervalHistogram` this module needs — narrow so tests can inject a fake without implementing the full native interface. */
export interface EventLoopHistogramLike {
  readonly count: number;
  readonly max: number;
  percentile(percentile: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

export interface StartEventLoopMonitorOptions {
  /** Test-only hook: inject a fake histogram instead of sampling the real event loop. */
  histogram?: EventLoopHistogramLike;
  /** Test-only hook: override the sampling window (default 5000ms). */
  intervalMs?: number;
}

let activeHistogram: EventLoopHistogramLike | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function stallThresholdMs(): number {
  const raw = Number(process.env.EH_PERF_LOOP_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_MS;
}

function sampleAndReset(h: EventLoopHistogramLike, windowMs: number): void {
  // No ticks landed in this window (e.g. right after enable()) — nothing to report.
  if (h.count === 0) return;

  const p50 = h.percentile(50) / NS_PER_MS;
  const p99 = h.percentile(99) / NS_PER_MS;
  const max = h.max / NS_PER_MS;
  recordDuration('eventloop.p50', p50);
  recordDuration('eventloop.p99', p99);
  recordDuration('eventloop.max', max);

  const threshold = stallThresholdMs();
  if (max > threshold) {
    const message = `[perf] event loop stalled ${max.toFixed(1)}ms in the last ${(windowMs / 1000).toFixed(0)}s window`;
    log.warn(message);
    broadcastEvent('perf', { kind: 'loop-stall', message, valueMs: max });
  }

  h.reset();
}

/** Idempotent — a second call while already running is a no-op. */
export function startEventLoopMonitor(opts: StartEventLoopMonitorOptions = {}): void {
  if (activeHistogram) return;

  const h = opts.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  activeHistogram = h;

  const windowMs = opts.intervalMs ?? DEFAULT_WINDOW_MS;
  timer = setInterval(() => sampleAndReset(h, windowMs), windowMs);
  timer.unref(); // never hold the process open just to keep sampling
}

export function stopEventLoopMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (activeHistogram) {
    activeHistogram.disable();
    activeHistogram = null;
  }
}
