/**
 * Watcher-storm detection (FLUX-1132): counts file-watcher-triggered ticket reloads into the
 * FLUX-1129 registry and warns when they cluster into a burst — the signature of a reload loop
 * (e.g. every agent history append round-tripping through chokidar back into `loadTask`). Uses a
 * simple tumbling window keyed off the first event's timestamp rather than a sliding log of
 * per-event times: cheap, allocation-free, and precise enough to answer "is this a storm right
 * now" for a debug metric, without needing exact event-rate math.
 */

import { incr } from './registry.js';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

const DEFAULT_STORM_THRESHOLD = 50;
const WINDOW_MS = 10_000;

function stormThreshold(): number {
  const raw = Number(process.env.EH_PERF_WATCH_STORM);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STORM_THRESHOLD;
}

let windowStartMs = 0;
let windowCount = 0;
let warnedThisWindow = false;

/**
 * Call once per watcher-triggered reload. `now` defaults to `Date.now()`; tests can pass an
 * explicit timestamp instead of relying on fake timers.
 */
export function recordWatchEvent(now: number = Date.now()): void {
  incr('store.watchEvents');

  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs = now;
    windowCount = 0;
    warnedThisWindow = false;
  }
  windowCount += 1;

  if (windowCount > stormThreshold() && !warnedThisWindow) {
    warnedThisWindow = true;
    const message = `[perf] watcher storm: ${windowCount} fs events in 10s`;
    log.warn(message);
    broadcastEvent('perf', { kind: 'watch-storm', message, detail: `${windowCount} events/10s` });
  }
}

/** Test-only teardown: reset rolling-window state between tests. */
export function resetWatchStormForTest(): void {
  windowStartMs = 0;
  windowCount = 0;
  warnedThisWindow = false;
}
