/**
 * Per-file loadTask() slow-load warning (FLUX-1202). `store.loadTask`'s histogram (recorded by
 * the caller in task-store.ts) already tracks the aggregate distribution, but it can't say
 * *which* ticket produced an outlier — FLUX-1190 observed a single loadTask() call hit 2.25s
 * with only the aggregate max to go on, forcing the culprit to be inferred from file sizes after
 * the fact. Warn per-file, naming the ticket, so a future spike is diagnosable directly from the
 * log instead of by inference.
 */

import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

const DEFAULT_SLOW_LOAD_TASK_MS = 500;

function slowLoadTaskThresholdMs(): number {
  const raw = Number(process.env.EH_PERF_SLOW_LOAD_TASK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_LOAD_TASK_MS;
}

/** Warns when a single loadTask() call for `filePath` crossed the slow threshold. The caller is
 *  still responsible for feeding the aggregate `store.loadTask` histogram via recordDuration —
 *  this only adds per-file identification on top of it. */
export function warnIfSlowLoadTask(filePath: string, ms: number): void {
  if (ms <= slowLoadTaskThresholdMs()) return;
  const message = `[perf] slow loadTask: ${filePath} took ${ms.toFixed(0)}ms`;
  log.warn(message);
  broadcastEvent('perf', { kind: 'slow-load-task', message, valueMs: ms, filePath });
}
