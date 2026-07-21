// FLUX-1601: after a session terminates `auth-expired`, watch for the human re-authenticating so the
// failed turn can auto-retry without an app restart — the user shouldn't have to notice the chat is
// stuck, run `claude login` in a terminal, then come back and re-type their message.
//
// Detection is a bounded mtime poll of `~/.claude/.credentials.json` (the file `claude login` writes
// on success) rather than an fs.watch — a single-file watch is flaky cross-platform (Windows in
// particular), and polling is trivially testable with injected deps, mirroring auth-diagnostics.ts's
// dependency-injection style for its own probes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { broadcastEvent } from '../events.js';

const POLL_INTERVAL_MS = 3_000;
// Bounded per the ticket — a credential that's never refreshed must not poll forever.
const MAX_WATCH_MS = 15 * 60 * 1000;

export interface AuthRecoveryWatchDeps {
  /** Returns the file's mtime in ms, or undefined if it doesn't exist / can't be read. */
  statMtimeMs?: (filePath: string) => number | undefined;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  broadcast?: typeof broadcastEvent;
  credentialsPath?: string;
}

function defaultStatMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

interface ActiveWatch { stop: () => void }
const activeWatches = new Map<string, ActiveWatch>();

/**
 * Start (or restart) a bounded credential-refresh watch for `taskId`. Broadcasts `authRecovered`
 * (`{ taskId }`) the instant `~/.claude/.credentials.json`'s mtime changes — including the file
 * appearing for the first time, which also counts as "logged in" — then stops itself. A second call
 * for the same `taskId` (a fresh auth failure before the first watch resolved) replaces, not stacks
 * on, the prior one.
 */
export function watchForCredentialRefresh(taskId: string, deps: AuthRecoveryWatchDeps = {}): void {
  const statMtimeMs = deps.statMtimeMs ?? defaultStatMtimeMs;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const broadcast = deps.broadcast ?? broadcastEvent;
  const credentialsPath = deps.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json');

  activeWatches.get(taskId)?.stop();

  const baseline = statMtimeMs(credentialsPath);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(poll);
    clearTimeoutFn(bound);
    if (activeWatches.get(taskId) === handle) activeWatches.delete(taskId);
  };

  const poll = setIntervalFn(() => {
    const mtime = statMtimeMs(credentialsPath);
    if (mtime !== undefined && mtime !== baseline) {
      stop();
      broadcast('authRecovered', { taskId });
    }
  }, POLL_INTERVAL_MS);
  const bound = setTimeoutFn(stop, MAX_WATCH_MS);
  // Never hold the process open just for this poll.
  (poll as unknown as { unref?: () => void }).unref?.();
  (bound as unknown as { unref?: () => void }).unref?.();

  const handle: ActiveWatch = { stop };
  activeWatches.set(taskId, handle);
}

/** Stop a task's active watch, if any — e.g. when a fresh (non-auth) turn supersedes the failure. */
export function stopCredentialWatch(taskId: string): void {
  activeWatches.get(taskId)?.stop();
}
