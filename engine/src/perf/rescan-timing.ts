/**
 * Full-rescan timing (FLUX-1132, re-split in FLUX-1184): `initDir()` (the actual disk scan —
 * reads every top-level ticket file) feeds `store.fullRescan` alone now. `activateWorkspace()`
 * (the whole workspace switch: watchers, sync, group docs, member binding, ... which itself
 * calls `initDir()`) used to feed the *same* metric with its own larger, superset duration —
 * so a single boot produced two "[perf] slow full rescan" warnings for one conceptual event,
 * reading as if the store had been rescanned twice. It now feeds the separate
 * `recordWorkspaceActivation()`/`store.workspaceActivation` below, so `store.fullRescan` is
 * exactly one sample per boot (the disk scan) and the umbrella activation time is labeled for
 * what it actually is. Kept as a tiny standalone module (mirrors `git-timing.ts`/
 * `event-loop-monitor.ts`) so the threshold/warn logic is unit-testable without exercising
 * either heavy call site.
 */

import { recordDuration } from './registry.js';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

const DEFAULT_SLOW_RESCAN_MS = 1000;
const DEFAULT_SLOW_ACTIVATION_MS = 2000;

function slowRescanThresholdMs(): number {
  const raw = Number(process.env.EH_PERF_SLOW_RESCAN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_RESCAN_MS;
}

function slowActivationThresholdMs(): number {
  const raw = Number(process.env.EH_PERF_SLOW_ACTIVATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_ACTIVATION_MS;
}

/** Records one full-rescan duration (`initDir()` only) and warns if it crossed the slow threshold. */
export function recordFullRescan(ms: number): void {
  recordDuration('store.fullRescan', ms);
  if (ms > slowRescanThresholdMs()) {
    const message = `[perf] slow full rescan: ${ms.toFixed(0)}ms`;
    log.warn(message);
    broadcastEvent('perf', { kind: 'slow-rescan', message, valueMs: ms });
  }
}

/**
 * Records one whole-workspace-activation duration (`activateWorkspace()`, which nests its own
 * `initDir()` rescan plus watcher/sync/group-docs/member-binding setup) under its own metric —
 * distinct from `store.fullRescan` so the two don't read as duplicate disk rescans.
 */
export function recordWorkspaceActivation(ms: number): void {
  recordDuration('store.workspaceActivation', ms);
  if (ms > slowActivationThresholdMs()) {
    log.warn(`[perf] slow workspace activation: ${ms.toFixed(0)}ms`);
  }
}
