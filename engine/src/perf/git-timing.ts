/**
 * Git/gh subprocess timing (FLUX-1131): rides the existing `setGitOperationSink` choke point
 * (FLUX-996/997 — every git/gh spawn funnels through `runHardened()`) to feed each call's
 * duration into the FLUX-1129 perf registry and warn on slow calls, without touching any
 * git-exec call site. `setGitOperationSink` is a multicast (git-exec.ts) — this coexists with
 * S9's operation-telemetry sink rather than replacing it.
 */

import { setGitOperationSink, redactArg, type GitOperationEvent } from '../git-exec.js';
import { recordDuration } from './registry.js';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

const DEFAULT_SLOW_GIT_MS = 2000;

function slowThresholdMs(): number {
  const raw = Number(process.env.EH_PERF_SLOW_GIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_GIT_MS;
}

/**
 * First non-flag arg, e.g. `status` from `['status', '--short']` or `pr` from
 * `['pr', 'view', '123']` — bounded cardinality (a handful of git/gh subcommands), never the
 * full argv (which can carry branch names, paths, or ticket ids).
 */
function verbOf(args: readonly string[]): string {
  return args.find((a) => !a.startsWith('-')) ?? 'unknown';
}

/** Exported for tests — feed synthetic `GitOperationEvent`s without spawning a real subprocess. */
export function handleGitOperationEvent(e: GitOperationEvent): void {
  recordDuration(`${e.file}.${verbOf(e.args)}`, e.durationMs);

  if (e.durationMs > slowThresholdMs()) {
    // e.args is already redacted by git-exec's emit(); redactArg here too in case a future
    // caller starts passing raw args through some other path.
    const cmd = redactArg(`${e.file} ${e.args.join(' ')}`);
    const message = `[perf] slow git: ${cmd} took ${e.durationMs.toFixed(0)}ms`;
    log.warn(message);
    broadcastEvent('perf', { kind: 'slow-git', message, valueMs: e.durationMs, detail: cmd });
  }
}

let installed = false;

/** Idempotent — a second call while already running is a no-op. */
export function startGitTiming(): void {
  if (installed) return;
  installed = true;
  setGitOperationSink(handleGitOperationEvent);
}

/**
 * Test-only teardown: `setGitOperationSink(null)` is a blunt "clear every sink" reset (see
 * git-exec.ts), safe here only because tests don't also have operation-telemetry's sink
 * installed in the same module registry. Never called from production code.
 */
export function stopGitTiming(): void {
  if (!installed) return;
  installed = false;
  setGitOperationSink(null);
}
