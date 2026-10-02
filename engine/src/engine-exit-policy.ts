// FLUX-1797: what the dev supervisor (dev-watcher.ts) does after the engine process exits. Pure, so
// every branch is unit-testable without spawning anything.
//
// Before this, `npm run dev:stable` ran the engine with NO supervisor at all — any exit (a crash, an
// OOM abort, a hard kill) was final and silent — and `/api/restart` exited 0, which only came back up
// when the file-watcher happened to have a restart flagged.

/** Exit code the engine uses for "restart me" (`/api/restart`, the dev auto-restart). EX_TEMPFAIL. */
export const RESTART_EXIT_CODE = 75;

/** A crash loop: more than this many crashes inside {@link CRASH_WINDOW_MS} stops respawning. */
export const MAX_CRASHES_IN_WINDOW = 5;
export const CRASH_WINDOW_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export type EngineExitDecision =
  | { action: 'respawn'; delayMs: number; reason: string; crash: boolean }
  | { action: 'stop'; reason: string };

export function decideAfterEngineExit(input: {
  code: number | null;
  signal: string | null;
  /** The watcher already decided to restart (an engine/src change). */
  restartPending: boolean;
  /** The supervisor itself is shutting down (Ctrl-C / SIGTERM). */
  stopping: boolean;
  /** Timestamps (ms) of earlier crashes — the caller keeps the list; this call does not mutate it. */
  recentCrashTimes: readonly number[];
  now: number;
}): EngineExitDecision {
  if (input.stopping) return { action: 'stop', reason: 'supervisor stopping' };
  if (input.restartPending || input.code === RESTART_EXIT_CODE) {
    return { action: 'respawn', delayMs: 0, reason: 'restart requested', crash: false };
  }
  if (input.code === 0 && !input.signal) return { action: 'stop', reason: 'clean exit' };

  const crashes = input.recentCrashTimes.filter((t) => input.now - t < CRASH_WINDOW_MS).length + 1;
  const how = input.signal ? `signal ${input.signal}` : `code ${input.code}`;
  if (crashes > MAX_CRASHES_IN_WINDOW) {
    return { action: 'stop', reason: `crash loop — ${crashes} exits in ${CRASH_WINDOW_MS / 60_000} min (last: ${how})` };
  }
  const delayMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (crashes - 1));
  return { action: 'respawn', delayMs, reason: `unexpected exit (${how}), crash ${crashes}/${MAX_CRASHES_IN_WINDOW}`, crash: true };
}
