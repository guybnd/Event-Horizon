import { log } from './log.js';
import path from 'path';
import { execFile, type ExecFileException } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import matter from 'gray-matter';
import { isOrphanMode, getFluxStoreDir } from './workspace.js';
import { getConfig } from './config.js';
import {
  buildGitSyncEnv,
  classifyGitError,
  invalidateGhAuthCache,
  GIT_SYNC_TIMEOUT_MS,
  SYNC_AUTH_REMEDIATION,
  type SyncRemediation,
} from './git-sync-env.js';
import { generateSyncAuthNotification, clearSyncAuthNotification, generateSyncConflictNotification, clearSyncConflictNotification } from './notifications.js';
import { getHistoryTimestamp, historyEntryIdentity, type HistoryEntryLike } from './history.js';
import { runGit } from './git-exec.js';
import { readJournalEntries, dropFlushedJournalEntries, replayJournalEntry, reloadCacheAfterReset } from './sync-journal.js';

const execFileAsyncRaw = promisify(execFile);
// All sync git calls go through here so they share the non-interactive +
// gh-authenticated environment (FLUX-895): no credential popup can fire, and a
// gh-logged-in user authenticates without interaction.
async function execFileAsync(file: string, args: string[]) {
  // Every call here operates on the flux-data store via `-C storeDir` baked into `args` by every
  // caller below (not an execFile `cwd` option) — reuse it (rather than calling getFluxStoreDir(),
  // which requires a bound workspace and would break storeDir-parameterized callers/tests) to
  // scope buildGitSyncEnv's gh-credential injection to that store's actual `origin` remote rather
  // than any repo a gh-authed user happens to be touching (FLUX-987).
  const gitCwd = args[0] === '-C' ? args[1] : undefined;
  const env = await buildGitSyncEnv(gitCwd);
  try {
    return await execFileAsyncRaw(file, args, { windowsHide: true, env, timeout: GIT_SYNC_TIMEOUT_MS });
  } catch (err: unknown) {
    // FLUX-989: on timeout, Node's execFile sends the child a single SIGTERM (the
    // default killSignal — we never override it) and does NOT escalate to SIGKILL if
    // the child ignores it. Rewrite the opaque "Command failed …" into a clear,
    // classifiable message so the status indicator surfaces it and `classifyGitError`
    // tags it `network` (it matches "timed out") — the retry timer then recovers
    // instead of the promise hanging forever.
    const execErr = err as ExecFileException;
    if (execErr && execErr.killed && execErr.signal === 'SIGTERM') {
      throw new Error(`git operation timed out after ${GIT_SYNC_TIMEOUT_MS / 1000}s: ${file} ${args.join(' ')}`, { cause: err });
    }
    throw err;
  }
}

// On an auth failure, stop the 30s retry hammer — back the retry timer off to a
// slow cadence. A successful sync (or a manual retry) clears it (FLUX-895).
const AUTH_RETRY_DELAY_MS = 5 * 60_000;

// FLUX-1428: push-as-CAS bounded retries — a rejected push means the remote moved; reset+replay
// and try again. Bounded so a sustained multi-engine push storm surfaces as a sync-status error
// (the caller's retry timer picks it back up next tick) instead of spinning forever within one tick.
const CAS_MAX_ATTEMPTS = 5;

// A push rejection from a non-fast-forward remote — the CAS signal to reset+replay, distinct from
// classifyGitError's network/auth/unknown buckets (git's own wording, not ours to reclassify there).
function isNonFastForwardRejection(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes('[rejected]') || msg.includes('non-fast-forward') || msg.includes('fetch first')
    || msg.includes('behind its remote counterpart') || msg.includes('updates were rejected');
}

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let scheduler: ReturnType<typeof createScheduler> | null = null;

// FLUX-1426/1428: the sync protocol version this engine build implements. Bumped only when a
// sync-protocol change ships — never auto-incremented at runtime (this literal is the deliberate
// bump). Compared against the `sync-protocol` marker file committed at the flux-data store root
// (seeded/forward-bumped in storage-sync.ts) to fence out an engine that predates a protocol
// change the store now requires. 1 = merge-based sync (FLUX-1426 gate only). 2 = push-as-CAS +
// idempotent journal replay (FLUX-1428) — a v1 engine no longer understands how the store
// resolves a lost race, so it must not touch it once any engine has bumped the marker to 2.
export const SUPPORTED_SYNC_PROTOCOL = 2;

export const SYNC_PROTOCOL_MARKER_FILE = 'sync-protocol';

export interface ConflictInfo {
  ticketId: string;
  localContent: string;
  remoteContent: string;
}

export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'synced'; lastSyncTime: string }
  | { state: 'conflict'; conflicts: ConflictInfo[] }
  // FLUX-1232: local and remote flux-data have both moved since their common ancestor — the
  // dev-machine-swap wedge this ticket hardens against. Surfaced BEFORE any auto-merge is
  // attempted (see storage-sync.ts's background `pull --ff-only` failure handling) so the
  // portal can offer the force-reset-to-remote escape hatch instead of letting the periodic
  // sync risk a many-file conflict. `ahead`/`behind` are commit counts vs origin/flux-data.
  | { state: 'diverged'; ahead: number; behind: number }
  // FLUX-895: `remediation` carries engine-owned, copy-paste fix steps for the
  // `auth` case so the portal renders an actionable "sign-in needed" panel
  // instead of a raw error string.
  | { state: 'error'; error: string; errorType: 'network' | 'auth' | 'conflict' | 'unknown'; remediation?: SyncRemediation }
  // FLUX-1426: the flux-data store's `sync-protocol` marker is ahead of what this engine
  // build supports — sync is fenced read-only (no add/commit/merge/push) until the engine is
  // upgraded. Clears automatically once a tick observes `marker <= SUPPORTED_SYNC_PROTOCOL`.
  | { state: 'protocol-mismatch'; required: number; supported: number };

let currentStatus: SyncStatus = { state: 'idle' };
const statusListeners: Array<(status: SyncStatus) => void> = [];
let pendingConflicts: ConflictInfo[] | null = null;

// FLUX-1079/FLUX-1088: a standing error notification (sync conflict, or FLUX-895 auth
// failure) is only ever (re)created when its `generate*Notification` call actually runs —
// some in-memory fast paths (e.g. `pendingConflicts && pendingConflicts.length > 0` below) and
// dead-end failure paths (e.g. the resolveConflicts() push-failure branch, which has no
// `onFail` to re-arm the retry timer) skip notifying on later ticks. If the standing
// notification gets dismissed while the underlying condition is still unresolved, nothing
// re-creates it — silently reproducing the exact "sits unnoticed for hundreds of commits"
// failure mode FLUX-1076 hardened against, for as long as the engine keeps running. Re-fire
// on a slow cadence (hours, not the 30s sync-retry cadence) independent of any portal client
// polling — the AFK scenario this exists for has none. `generateSync*Notification` itself
// already no-ops into a refresh when the standing entry is still active (not dismissed), so
// it's safe to call unconditionally once the interval elapses.
const RESURFACE_INTERVAL_MS = 4 * 60 * 60_000; // 4 hours
let lastConflictNotifyAt = 0;
let lastAuthNotifyAt = 0;
let resurfaceTimer: ReturnType<typeof setInterval> | null = null;

function notifyConflict(count: number): void {
  generateSyncConflictNotification(count);
  lastConflictNotifyAt = Date.now();
}

function notifyAuthFailure(): void {
  generateSyncAuthNotification();
  lastAuthNotifyAt = Date.now();
}

// Exported so it can be driven directly in tests (and by the periodic timer in
// startSyncWatcher) without waiting out RESURFACE_INTERVAL_MS in real time.
export function maybeResurfaceConflictNotification(nowMs: number = Date.now()): void {
  if (currentStatus.state !== 'conflict' || !pendingConflicts || pendingConflicts.length === 0) return;
  if (nowMs - lastConflictNotifyAt < RESURFACE_INTERVAL_MS) return;
  notifyConflict(pendingConflicts.length);
}

// Mirrors maybeResurfaceConflictNotification above for the FLUX-895 auth notification (FLUX-1088).
export function maybeResurfaceAuthNotification(nowMs: number = Date.now()): void {
  if (currentStatus.state !== 'error' || currentStatus.errorType !== 'auth') return;
  if (nowMs - lastAuthNotifyAt < RESURFACE_INTERVAL_MS) return;
  notifyAuthFailure();
}

// FLUX-989: single in-process mutex shared by runSync() and resolveConflicts(). Both
// touch the same .flux-store worktree; without it, resolveConflicts() writing the
// resolved .md files re-triggers the chokidar watcher and can schedule a concurrent
// runSync() tick — two git processes then race on one worktree (index.lock collisions,
// or one side blocked on the network while the other proceeds). Acquire before touching
// the worktree, release in a finally. runSync() no-ops when it's held; resolveConflicts()
// (user-initiated) rejects with a clear "retry in a moment" so the caller isn't dropped
// silently.
let syncInFlight = false;

function updateStatus(status: SyncStatus): void {
  currentStatus = status;
  statusListeners.forEach((listener, index) => {
    try {
      listener(status);
    } catch (err) {
      console.error(`[sync-watcher] Error in status listener ${index}:`, err);
      // Remove failed listener to prevent future errors
      const idx = statusListeners.indexOf(listener);
      if (idx !== -1) statusListeners.splice(idx, 1);
    }
  });
}

// A sync completed — mark synced and clear any standing auth re-login notice so
// the indicator/notification recover on their own (FLUX-895 acceptance).
function markSynced(): void {
  updateStatus({ state: 'synced', lastSyncTime: new Date().toISOString() });
  clearSyncAuthNotification();
  clearSyncConflictNotification();
}

// Report a git failure: classify it, and for an `auth` failure attach the
// remediation payload, raise the persistent re-auth notification, drop the cached
// gh-auth result (so a fresh `gh auth login` is re-detected next cycle), and back
// the retry off so we stop hammering every 30s (FLUX-895). `onFail` re-arms the
// retry timer with the supplied delay (default cadence when omitted).
function reportSyncFailure(errorMsg: string, onFail?: (retryDelayMs?: number) => void): void {
  const errorType = classifyGitError(errorMsg);
  if (errorType === 'auth') {
    invalidateGhAuthCache();
    updateStatus({ state: 'error', error: errorMsg, errorType, remediation: SYNC_AUTH_REMEDIATION });
    notifyAuthFailure();
    onFail?.(AUTH_RETRY_DELAY_MS);
    return;
  }
  updateStatus({ state: 'error', error: errorMsg, errorType });
  onFail?.();
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

// FLUX-1076: true while flux-data sync is genuinely wedged — a conflict awaiting resolution,
// or a hard sync error (push/fetch/auth failure). The PR-scanner (pr-tickets.ts) checks this
// before creating a brand-new PR ticket: while sync can't reach the remote, tasksCache may be
// missing a ticket that already exists there, and materializing a fresh skeleton for it is
// exactly how the prior incident's wedge perpetuated itself (every stub creation is a fresh
// add/add conflict on the next successful pull). Existing-ticket updates aren't gated by this —
// only net-new creation needs to wait for sync to be healthy again.
export function isSyncUnhealthy(): boolean {
  return currentStatus.state === 'conflict' || currentStatus.state === 'error' || currentStatus.state === 'diverged'
    || currentStatus.state === 'protocol-mismatch';
}

// FLUX-1232: called by storage-sync.ts's background startup pull when `git pull --ff-only`
// fails for a reason other than network/auth — the only remaining reason that fails is a true
// divergence (neither side is an ancestor of the other). Doesn't touch pendingConflicts/error
// state if one is already showing — a real conflict or error is more actionable/urgent than an
// early divergence heads-up, and the periodic sync (triggerSync(), run right after this during
// workspace activation) will re-derive the real status moments later regardless.
export function reportDivergedStatus(ahead: number, behind: number): void {
  if (currentStatus.state === 'conflict' || currentStatus.state === 'error') return;
  updateStatus({ state: 'diverged', ahead, behind });
}

// FLUX-1232: called after forceResetToRemote() completes — the worktree now exactly matches
// origin/flux-data, so any stale conflict/diverged/error state must not keep showing.
export function clearSyncStateAfterForceReset(): void {
  pendingConflicts = null;
  markSynced();
}

// FLUX-1232: acquire the same in-flight mutex runSync()/resolveConflicts() use, so
// forceResetToRemote() can't race a background sync on the same worktree (FLUX-989). Throws the
// same "retry in a moment" error resolveConflicts() does when the lock is already held.
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  if (syncInFlight) {
    throw new Error('A sync is currently in progress; please retry in a moment.');
  }
  syncInFlight = true;
  try {
    return await fn();
  } finally {
    syncInFlight = false;
  }
}

// FLUX-989: `pendingConflicts` is trusted as ground truth once set, but the worktree can
// be fixed out-of-band (manually, or by a prior partially-succeeded resolution) — the
// banner then keeps showing a conflict that no longer exists until the engine restarts.
// Re-derive the conflict from the live worktree before serving `state: 'conflict'`: if
// there is no unmerged state anymore, drop it; if it's still unmerged, refresh the list
// from disk. No-op unless we currently claim a conflict, so the common path stays cheap.
// Skips while a sync/resolution holds the lock (the in-flight op owns the truth).
export async function revalidateConflictState(): Promise<SyncStatus> {
  if (currentStatus.state !== 'conflict' || !isOrphanMode() || syncInFlight) return currentStatus;
  const storeDir = getFluxStoreDir();
  try {
    if (!(await hasUnmergedState(storeDir))) {
      // Worktree is clean — the conflict was resolved out-of-band. Stop showing it; the
      // next watcher tick / manual retry re-derives real sync state from here.
      pendingConflicts = null;
      updateStatus({ state: 'idle' });
      clearSyncConflictNotification();
      log.info('[sync-watcher] Stale conflict cleared — worktree no longer has unmerged state.');
    } else {
      // Still genuinely conflicted — refresh the surfaced list from the live worktree.
      const conflicts = await detectMergeConflicts(storeDir);
      if (conflicts.length > 0) {
        pendingConflicts = conflicts;
        updateStatus({ state: 'conflict', conflicts });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`[sync-watcher] conflict re-validation failed: ${message}`);
  }
  return currentStatus;
}

export function onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
  statusListeners.push(listener);
  // Return unsubscribe function
  return () => {
    const idx = statusListeners.indexOf(listener);
    if (idx !== -1) statusListeners.splice(idx, 1);
  };
}

// Test-only: reset module-global sync state between vitest cases. Not used in production.
export function _resetSyncStateForTests(): void {
  pendingConflicts = null;
  currentStatus = { state: 'idle' };
  syncInFlight = false;
  lastConflictNotifyAt = 0;
  lastAuthNotifyAt = 0;
  _testOnAfterResetHook = null;
}

// FLUX-1428: see the call site in runSync's CAS loop — test-only, no-op unless a test sets it.
let _testOnAfterResetHook: (() => Promise<void>) | null = null;
export function _setPostResetHookForTests(fn: (() => Promise<void>) | null): void {
  _testOnAfterResetHook = fn;
}

// Test-only: drive the module straight into the FLUX-895 auth-failure state (the same
// `updateStatus`/notify sequence `reportSyncFailure` runs on a real classified-`auth` git
// error), without needing a real git remote that produces a classifiable auth failure —
// that would be network-dependent and platform-fragile (Windows/Linux emit different
// credential-helper error text) for what maybeResurfaceAuthNotification tests need to
// exercise: the dismissed-notification resurface logic, not git error classification.
export function _simulateAuthFailureForTests(): void {
  updateStatus({ state: 'error', error: 'test auth failure', errorType: 'auth', remediation: SYNC_AUTH_REMEDIATION });
  notifyAuthFailure();
}

export function triggerSync(): void {
  if (!isOrphanMode()) return;
  // A manual sync (the "Retry" action / clicking the indicator) re-detects gh auth
  // immediately rather than waiting out the cache, so a just-completed `gh auth
  // login` takes effect on this attempt (FLUX-895).
  invalidateGhAuthCache();
  const storeDir = getFluxStoreDir();
  void runSync(storeDir, (delayMs?: number) => scheduler?.scheduleRetry(delayMs));
}

export function triggerTestError(): void {
  updateStatus({
    state: 'error',
    error: 'This is a test error for UI development. The actual sync error was: "Command failed: git -C <workspace>/.flux-store commit -m flux: sync\\nfatal: Unable to create index.lock: File exists.\\n\\nAnother git process seems to be running in this repository, or the lock file may be stale."',
    errorType: 'unknown'
  });
  log.info('[sync-watcher] Test error triggered for UI testing');
}

export async function allocateNewTicketId(storeDir: string, projectKey: string): Promise<string> {
  const files = await fs.readdir(storeDir);
  let maxId = 0;

  for (const file of files) {
    if (file.startsWith(`${projectKey}-`) && file.endsWith('.md')) {
      const idPart = file.replace(`${projectKey}-`, '').replace('.md', '');
      const num = parseInt(idPart, 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  }

  return `${projectKey}-${maxId + 1}`;
}

// Called after a failed git merge to collect files with unresolvable conflicts.
// Returns local (HEAD) vs remote content for each conflicted file.
async function detectMergeConflicts(storeDir: string): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];
  try {
    const { stdout: diffOut } = await execFileAsync('git', ['-C', storeDir, 'diff', '--name-only', '--diff-filter=U']);
    const files = diffOut.trim().split('\n').filter(f => f.endsWith('.md') && f);
    for (const file of files) {
      const ticketId = path.basename(file, '.md');
      try {
        const { stdout: localContent } = await execFileAsync('git', ['-C', storeDir, 'show', `HEAD:${file}`]);
        const { stdout: remoteContent } = await execFileAsync('git', ['-C', storeDir, 'show', `MERGE_HEAD:${file}`]);
        conflicts.push({ ticketId, localContent, remoteContent });
      } catch {
        log.info(`[sync-watcher] Skipping ${file} - error reading conflict content`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sync-watcher] Error reading merge conflicts:', message);
  }
  return conflicts;
}

/**
 * FLUX-1076: ticket history is append-only, so two sides that each recorded new progress since
 * a common ancestor don't actually disagree — they just both grew the same array, which git's
 * line-based 3-way merge sees as two edits to the same region and conflict-marks. When that is
 * the ONLY thing that differs (body identical, every other frontmatter field identical between
 * the two sides, and neither side dropped/mutated an entry the other still has), union the two
 * histories chronologically and resolve without ever surfacing this to a human. Anything else —
 * a genuinely different status/title, a changed body, a history entry that was edited rather
 * than purely appended, or a ticket that didn't exist at the merge-base (an add/add conflict,
 * e.g. the PR-scanner racing a pull) — returns null so the caller falls back to the existing
 * manual-resolution flow for exactly those cases.
 */
export function mergeAppendOnlyHistory(baseContent: string, oursContent: string, theirsContent: string): string | null {
  let base: matter.GrayMatterFile<string>;
  let ours: matter.GrayMatterFile<string>;
  let theirs: matter.GrayMatterFile<string>;
  try {
    base = matter(baseContent);
    ours = matter(oursContent);
    theirs = matter(theirsContent);
  } catch {
    return null;
  }

  if (ours.content.trim() !== theirs.content.trim()) return null;

  const baseHistoryRaw = (base.data ?? {}).history;
  const { history: oursHistory, ...oursRest } = ours.data ?? {};
  const { history: theirsHistory, ...theirsRest } = theirs.data ?? {};

  if (!Array.isArray(oursHistory) || !Array.isArray(theirsHistory)) return null;
  // Every non-history field must agree between the two sides — anything genuinely contested
  // (a status move, a title edit) on either side fails here rather than being guessed at.
  if (JSON.stringify(oursRest) !== JSON.stringify(theirsRest)) return null;

  const baseHistory = Array.isArray(baseHistoryRaw) ? baseHistoryRaw : [];
  const keyOf = (entry: unknown) => JSON.stringify(entry);
  const oursKeys = new Set(oursHistory.map(keyOf));
  const theirsKeys = new Set(theirsHistory.map(keyOf));

  // Either side dropping/mutating a base entry means the two histories no longer agree on
  // shared ground truth — not a pure append, so don't guess at a resolution.
  for (const entry of baseHistory) {
    const key = keyOf(entry);
    if (!oursKeys.has(key) || !theirsKeys.has(key)) return null;
  }

  const merged = new Map<string, unknown>();
  for (const entry of [...baseHistory, ...oursHistory, ...theirsHistory]) {
    merged.set(keyOf(entry), entry);
  }
  const mergedHistory = [...merged.values()].sort((a, b) => getHistoryTimestamp(a) - getHistoryTimestamp(b));

  return matter.stringify(ours.content, { ...oursRest, history: mergedHistory });
}

// FLUX-1427: GitHub-owned scalars on a PR-mirror card (`kind: 'pr'`) — re-derived by the ~90s
// syncPrTickets poll every cycle (pr-tickets.ts `prTicketFields`), so two sides disagreeing on
// these is never a real conflict to reason about, just staleness the next poll fixes regardless.
const PR_GITHUB_OWNED_SCALAR_FIELDS = [
  'prState', 'reviewDecision', 'isDraft', 'ciStatus', 'prNumber', 'branch', 'title', 'implementationLink',
] as const;

// Sticky, EH-set swimlanes the poller deliberately preserves (FLUX-986). When both sides carry a
// DIFFERENT sticky value, `merge-conflict` (the PR is blocked outright) outranks the lower-stakes
// `changes-requested` tint.
const PR_SWIMLANE_PRIORITY: Record<string, number> = { 'merge-conflict': 2, 'changes-requested': 1 };

function pickPrSwimlane(oursValue: unknown, theirsValue: unknown): string | null {
  const ours = typeof oursValue === 'string' ? oursValue : null;
  const theirs = typeof theirsValue === 'string' ? theirsValue : null;
  if (ours && theirs && ours !== theirs) {
    return (PR_SWIMLANE_PRIORITY[ours] ?? 0) >= (PR_SWIMLANE_PRIORITY[theirs] ?? 0) ? ours : theirs;
  }
  return ours ?? theirs ?? null;
}

// A PR ticket's own `status` is recorded as a `status_change` history entry only when a
// human/agent moves it via change_status (updateTaskWithHistory) — the poller (prTicketFields /
// upsertManagedTicket) overwrites the frontmatter field directly with no history entry (FLUX-566).
// So the unioned history's latest status_change is the authoritative signal for a genuine
// EH-authored move; when neither side recorded one, prefer whichever side isn't the bare poll
// default ('Ready') — a send-for-review In Progress must survive a poll-set Ready (FLUX-569).
function pickPrStatus(oursStatus: unknown, theirsStatus: unknown, mergedHistory: unknown[]): unknown {
  const ours = typeof oursStatus === 'string' ? oursStatus : undefined;
  const theirs = typeof theirsStatus === 'string' ? theirsStatus : undefined;
  if (ours === theirs) return ours ?? theirs;

  for (let i = mergedHistory.length - 1; i >= 0; i--) {
    const entry = mergedHistory[i] as Record<string, unknown> | null;
    if (!entry || entry.type !== 'status_change') continue;
    const to = typeof entry.to === 'string' ? entry.to : (typeof entry.newStatus === 'string' ? entry.newStatus : undefined);
    if (to != null && (to === ours || to === theirs)) return to;
  }

  if (ours === 'Ready' && theirs !== 'Ready') return theirs;
  if (theirs === 'Ready' && ours !== 'Ready') return ours;
  return ours ?? theirs;
}

function unionStringArray(a: unknown, b: unknown): string[] {
  const arrA = Array.isArray(a) ? a.filter((v): v is string => typeof v === 'string') : [];
  const arrB = Array.isArray(b) ? b.filter((v): v is string => typeof v === 'string') : [];
  return [...new Set([...arrA, ...arrB])].sort();
}

/**
 * FLUX-1427: field-class-aware conflict resolution for PR-mirror cards (`kind: 'pr'`). Unlike
 * mergeAppendOnlyHistory above — which refuses whenever ANY non-history field differs — a PR
 * card's GitHub-owned scalars are EXPECTED to legitimately differ between two sides that each
 * polled gh at a slightly different moment; that's staleness, not a real disagreement. Resolves
 * per the field-ownership taxonomy in the ticket body: GitHub-owned scalars take the remote
 * (theirs) value; `history[]` unions by entry identity (FLUX-1308); `swimlane`/`status`/`members`
 * follow EH-ownership preservation rules. Returns null (falls back to manual resolution) only
 * when neither side is a PR card, or the frontmatter is unparseable.
 */
export function mergePrTicketConflict(baseContent: string, oursContent: string, theirsContent: string): string | null {
  let ours: matter.GrayMatterFile<string>;
  let theirs: matter.GrayMatterFile<string>;
  try {
    ours = matter(oursContent);
    theirs = matter(theirsContent);
  } catch {
    return null;
  }

  if (ours.data?.kind !== 'pr' && theirs.data?.kind !== 'pr') return null;

  let baseHistory: unknown[] = [];
  try {
    const base = baseContent ? matter(baseContent) : null;
    if (Array.isArray(base?.data?.history)) baseHistory = base!.data.history;
  } catch {
    baseHistory = [];
  }

  const oursHistory = Array.isArray(ours.data.history) ? ours.data.history : [];
  const theirsHistory = Array.isArray(theirs.data.history) ? theirs.data.history : [];

  const mergedById = new Map<string, unknown>();
  for (const entry of [...baseHistory, ...oursHistory, ...theirsHistory]) {
    mergedById.set(historyEntryIdentity((entry ?? {}) as HistoryEntryLike), entry);
  }
  const mergedHistory = [...mergedById.values()].sort((a, b) => getHistoryTimestamp(a) - getHistoryTimestamp(b));

  // Base: ours (mirrors mergeAppendOnlyHistory's own default), with the fields below overridden.
  const fields: Record<string, unknown> = { ...theirs.data, ...ours.data };
  for (const field of PR_GITHUB_OWNED_SCALAR_FIELDS) {
    if (field in theirs.data) fields[field] = theirs.data[field];
    else if (field in ours.data) fields[field] = ours.data[field];
  }
  fields.swimlane = pickPrSwimlane(ours.data.swimlane, theirs.data.swimlane);
  fields.status = pickPrStatus(ours.data.status, theirs.data.status, mergedHistory) ?? fields.status;
  fields.members = unionStringArray(ours.data.members, theirs.data.members);
  fields.history = mergedHistory;

  // Body is GitHub-owned (the gh PR description, FLUX-751) — prefer remote, falling back to ours
  // for an add/add where theirs hasn't captured a description yet.
  const content = theirs.content.trim() ? theirs.content : ours.content;

  return matter.stringify(content, fields);
}

/**
 * Try the append-only history auto-merge (above) for every conflict git couldn't resolve on its
 * own, then the PR-mirror-card resolver (FLUX-1427) as a fallback. Reads each ticket's merge-base
 * version to tell a pure append from a real edit, writes and stages whatever resolves cleanly,
 * and returns whichever conflicts still need a human. A ticket file with no merge-base version
 * (created fresh on one side — an add/add conflict) is resolved against an empty base — the pure
 * append-only merge will correctly refuse it (unless it happens to genuinely be a pure append),
 * but the PR-card resolver is explicitly designed to handle this case (add/add on a brand-new
 * PR-<n> card, e.g. the PR-419/420/421 incident shape).
 */
async function autoResolveHistoryConflicts(storeDir: string, conflicts: ConflictInfo[]): Promise<ConflictInfo[]> {
  let mergeBase: string;
  try {
    const { stdout } = await runGit(['merge-base', 'HEAD', 'MERGE_HEAD'], { cwd: storeDir });
    mergeBase = stdout.trim();
  } catch {
    return conflicts; // no usable merge-base — leave everything for manual resolution
  }

  const remaining: ConflictInfo[] = [];
  for (const conflict of conflicts) {
    // Empty when the ticket didn't exist at the merge-base — an add/add conflict.
    const baseContent = await runGit(['show', `${mergeBase}:${conflict.ticketId}.md`], { cwd: storeDir })
      .then((r) => r.stdout)
      .catch(() => '');
    try {
      const merged = mergeAppendOnlyHistory(baseContent, conflict.localContent, conflict.remoteContent)
        ?? mergePrTicketConflict(baseContent, conflict.localContent, conflict.remoteContent);
      if (merged == null) {
        remaining.push(conflict);
        continue;
      }
      const filePath = path.join(storeDir, `${conflict.ticketId}.md`);
      await fs.writeFile(filePath, merged, 'utf-8');
      await runGit(['add', `${conflict.ticketId}.md`], { cwd: storeDir });
      log.info(`[sync-watcher] Auto-merged ${conflict.ticketId} (FLUX-1076/FLUX-1427)`);
    } catch {
      remaining.push(conflict);
    }
  }
  return remaining;
}

export async function resolveConflicts(
  resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'use-local' | 'rename-local' | 'manual'; newContent?: string }>
): Promise<void> {
  if (!pendingConflicts || pendingConflicts.length === 0) {
    throw new Error('No conflicts to resolve');
  }

  // FLUX-989: refuse to run while a background sync holds the worktree — racing git
  // processes on one worktree corrupt the merge. Reject clearly so the HTTP caller can
  // surface a real "retry in a moment" state instead of hanging behind the other side.
  if (syncInFlight) {
    throw new Error('A sync is currently in progress; please retry in a moment.');
  }

  const storeDir = getFluxStoreDir();

  // FLUX-1426: same read-only fence as runSync() — never commit/push a conflict resolution
  // into a store that requires a newer protocol than this engine supports.
  const headMarker = await readSyncProtocolMarker(storeDir, 'HEAD');
  if (headMarker > SUPPORTED_SYNC_PROTOCOL) {
    reportProtocolMismatch(headMarker);
    throw new Error(`This flux-data store requires sync protocol ${headMarker}; this engine only supports ${SUPPORTED_SYNC_PROTOCOL}. Upgrade the engine to resolve conflicts.`);
  }

  syncInFlight = true;
  try {
    await applyConflictResolutions(resolutions, storeDir);
  } finally {
    syncInFlight = false;
  }
}

// The worktree-mutating body of resolveConflicts, run under the syncInFlight lock so a
// chokidar-scheduled runSync() tick fired by our own .md writes no-ops instead of racing.
async function applyConflictResolutions(
  resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'use-local' | 'rename-local' | 'manual'; newContent?: string }>,
  storeDir: string
): Promise<void> {
  for (const resolution of resolutions) {
    const conflict = pendingConflicts!.find(c => c.ticketId === resolution.ticketId)!;
    const filePath = path.join(storeDir, `${resolution.ticketId}.md`);

    switch (resolution.strategy) {
      case 'use-remote':
        await fs.writeFile(filePath, conflict.remoteContent, 'utf-8');
        log.info(`[sync-watcher] Resolved ${resolution.ticketId}: used remote version`);
        break;

      case 'use-local':
        await fs.writeFile(filePath, conflict.localContent, 'utf-8');
        log.info(`[sync-watcher] Resolved ${resolution.ticketId}: used local version`);
        break;

      case 'rename-local': {
        const projectKey = resolution.ticketId.split('-')[0]!;
        const newId = await allocateNewTicketId(storeDir, projectKey);
        await fs.writeFile(filePath, conflict.remoteContent, 'utf-8');
        const parsed = matter(conflict.localContent);
        parsed.data.id = newId;
        const renamedContent = matter.stringify(parsed.content, parsed.data);
        await fs.writeFile(path.join(storeDir, `${newId}.md`), renamedContent, 'utf-8');
        log.info(`[sync-watcher] Resolved ${resolution.ticketId}: renamed local to ${newId}, accepted remote`);
        break;
      }

      case 'manual':
        await fs.writeFile(filePath, resolution.newContent!, 'utf-8');
        log.info(`[sync-watcher] Resolved ${resolution.ticketId}: used manual merge`);
        break;
    }
  }

  // Stage resolved files and commit the merge
  pendingConflicts = null;
  updateStatus({ state: 'syncing' });
  clearSyncConflictNotification();

  try {
    let addAttempts = 0;
    while (addAttempts < 3) {
      try {
        await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
        break;
      } catch (addErr: unknown) {
        const msg = addErr instanceof Error ? addErr.message : String(addErr);
        if (msg.includes('index.lock') && addAttempts < 2) {
          log.info(`[sync-watcher] Git lock detected on add, retrying in 1s (attempt ${addAttempts + 1}/3)...`);
          await new Promise(r => setTimeout(r, 1000));
          addAttempts++;
        } else {
          throw addErr;
        }
      }
    }

    await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync (resolved conflicts)']);
    log.info('[sync-watcher] Committed merge with resolved conflicts');
  } catch (err: unknown) {
    // FLUX-994: this used to fall through uncaught — status stayed stranded at 'syncing'
    // (set just above) until the next scheduled watcher tick happened to overwrite it,
    // whether or not an HTTP caller was still around to see the rejection (e.g. raced away
    // by the resolve-conflicts route's timeout). Report it the same way the push failure
    // below already does, then rethrow so a still-listening caller sees the real failure.
    const errorMsg = err instanceof Error ? err.message : String(err);
    reportSyncFailure(errorMsg);
    throw err;
  }

  try {
    await execFileAsync('git', ['-C', storeDir, 'push', 'origin', 'flux-data']);
    markSynced();
    log.info('[sync-watcher] Pushed resolved conflicts to remote');
  } catch (pushErr: unknown) {
    const errorMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    reportSyncFailure(errorMsg);
  }
}

// True if the worktree has an in-progress merge (MERGE_HEAD) or any unmerged
// (conflicted) paths. Used to refuse `git add -A`/commit while a merge is
// unresolved, so conflict markers can never be committed into a ticket (FLUX-703).
async function hasUnmergedState(storeDir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', storeDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return true; // MERGE_HEAD resolves ⇒ a merge is in progress
  } catch {
    // no MERGE_HEAD — fall through to check for stray unmerged paths
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', storeDir, 'diff', '--name-only', '--diff-filter=U']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// FLUX-1076: unlike hasUnmergedState above, this checks ONLY for still-conflicted (stage
// 1/2/3) index paths, ignoring MERGE_HEAD — which stays present for the whole in-progress
// merge regardless of whether every conflict has already been resolved and staged. Used right
// after autoResolveHistoryConflicts to ask "is anything still actually conflicted", where
// hasUnmergedState would wrongly answer "yes" just because the merge commit hasn't landed yet.
// Fails closed (treats a probe error as still-unresolved) — never risk committing on a lie.
async function hasUnresolvedConflictedPaths(storeDir: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: storeDir });
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

// FLUX-1426: read the `sync-protocol` marker at a given ref (`HEAD` for the worktree's current
// state, `origin/flux-data` right after a fetch). Missing file, unreadable ref, or unparseable
// content all resolve to `1` (the pre-gate baseline) — a store that predates this feature, or a
// ref this git can't reach, must never block sync on that basis alone.
async function readSyncProtocolMarker(storeDir: string, ref: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', storeDir, 'show', `${ref}:${SYNC_PROTOCOL_MARKER_FILE}`]);
    const parsed = parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    return 1;
  }
}

function reportProtocolMismatch(required: number): void {
  updateStatus({ state: 'protocol-mismatch', required, supported: SUPPORTED_SYNC_PROTOCOL });
  console.warn(`[sync-watcher] flux-data store requires sync-protocol ${required}, this engine supports ${SUPPORTED_SYNC_PROTOCOL} — sync is read-only until the engine is upgraded.`);
}

export async function runSync(storeDir: string, onFail?: (retryDelayMs?: number) => void): Promise<void> {
  // FLUX-989: a resolveConflicts() (or another sync tick) is already touching the
  // worktree. Proceeding now would race two git processes on one worktree. No-op — the
  // debounced scheduler / retry timer will re-run us after the lock frees.
  if (syncInFlight) {
    log.info('[sync-watcher] sync already in flight — skipping this tick');
    return;
  }

  // A conflict is already awaiting user resolution (in-memory fast path). Touching
  // the repo now would let Step 1's `git add -A`/commit bake the conflict markers
  // sitting in the worktree into a commit and corrupt the ticket YAML (FLUX-703).
  // The marker write also fires the chokidar watcher, so without this the parked
  // conflict self-triggers the very tick that commits it.
  if (pendingConflicts && pendingConflicts.length > 0) {
    updateStatus({ state: 'conflict', conflicts: pendingConflicts });
    return;
  }

  // FLUX-1426: the store already carries a protocol marker this engine can't handle (e.g. a
  // prior tick fetched and fast-forwarded it in, or another engine instance bumped it) — fence
  // out before touching the worktree at all, including the local add/commit in Step 1 below.
  const headMarker = await readSyncProtocolMarker(storeDir, 'HEAD');
  if (headMarker > SUPPORTED_SYNC_PROTOCOL) {
    reportProtocolMismatch(headMarker);
    return;
  }

  syncInFlight = true;
  updateStatus({ state: 'syncing' });

  try {
    // Guard (FLUX-703): never `git add -A`/commit on top of an in-progress or
    // half-finished merge. A prior tick — or a crash/restart mid-merge — can leave
    // conflict markers + MERGE_HEAD in the worktree; staging and committing them is
    // exactly what corrupted FLUX-694. Re-surface the conflict instead of committing.
    if (await hasUnmergedState(storeDir)) {
      let conflicts = await detectMergeConflicts(storeDir);
      if (conflicts.length > 0) {
        // FLUX-1076: most ticket-file conflicts are a pure append-only history race — try
        // resolving those automatically before asking a human.
        conflicts = await autoResolveHistoryConflicts(storeDir, conflicts);
      }
      if (conflicts.length > 0) {
        pendingConflicts = conflicts;
        updateStatus({ state: 'conflict', conflicts });
        // FLUX-1076: persist a Notification (not just the SSE status) so the wedge isn't
        // silent — the earlier incident had this state sit unnoticed for 315+ commits.
        notifyConflict(conflicts.length);
        console.warn(`[sync-watcher] Unresolved merge state on entry (${conflicts.length} ticket conflict(s)) — awaiting resolution, not committing.`);
        return;
      }
      if (!(await hasUnresolvedConflictedPaths(storeDir))) {
        // FLUX-1076: every unmerged path was a ticket conflict and it auto-resolved (or there
        // was nothing to resolve in the first place) — fall through to Step 1 below, which
        // commits what's now staged and completes the in-progress merge, instead of the
        // merge --abort path below meant for a merge with no resolvable ticket conflicts.
        log.info('[sync-watcher] Conflicts auto-resolved via append-only history union — continuing sync.');
      } else {
        // Merge in progress but nothing we can surface as a ticket-level conflict —
        // abort it to recover a clean local tree, then sync normally.
        console.warn('[sync-watcher] In-progress merge with no resolvable ticket conflicts — aborting merge to recover a clean tree.');
        await execFileAsync('git', ['-C', storeDir, 'merge', '--abort']).catch(() => {});

        // FLUX-706: if unmerged paths PERSIST after the abort (e.g. unmerged index entries with
        // no MERGE_HEAD — only reachable via manual external git surgery inside .flux-store), do
        // NOT fall through to Step 1's `git add -A`, which would stage conflict-marked content.
        // Hard-stop and surface an error instead of risking baking markers into a ticket. Fail
        // CLOSED: if the probe itself can't be read, treat the tree as still-unmerged. (The error
        // re-surfaces on each retry tick until a human cleans the worktree — that recurrence is
        // intentional, not a spin: each tick terminates and the retry timer is debounced.)
        let unmergedOut = '';
        try {
          ({ stdout: unmergedOut } = await execFileAsync('git', ['-C', storeDir, 'diff', '--name-only', '--diff-filter=U']));
        } catch {
          unmergedOut = 'probe-failed';
        }
        if (unmergedOut.trim()) {
          console.error('[sync-watcher] Unmerged paths persist after `merge --abort` — refusing to `git add -A`. Resolve the .flux-store worktree manually.');
          updateStatus({ state: 'error', error: 'Unmerged paths persist in .flux-store after merge --abort; refusing to commit to avoid baking conflict markers into a ticket.', errorType: 'unknown' });
          onFail?.();
          return;
        }
      }
    }

    // Step 1: commit any pending local changes first
    let addAttempts = 0;
    while (addAttempts < 3) {
      try {
        await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
        break;
      } catch (addErr: unknown) {
        const msg = addErr instanceof Error ? addErr.message : String(addErr);
        if (msg.includes('index.lock') && addAttempts < 2) {
          log.info(`[sync-watcher] Git lock detected on add, retrying in 1s (attempt ${addAttempts + 1}/3)...`);
          await new Promise(r => setTimeout(r, 1000));
          addAttempts++;
        } else {
          throw addErr;
        }
      }
    }

    const { stdout: porcelain } = await execFileAsync('git', ['-C', storeDir, 'status', '--porcelain']);
    if (porcelain.trim()) {
      let commitAttempts = 0;
      while (commitAttempts < 3) {
        try {
          await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync']);
          log.info('[sync-watcher] Committed local changes');
          break;
        } catch (commitErr: unknown) {
          const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (msg.includes('index.lock') && commitAttempts < 2) {
            log.info(`[sync-watcher] Git lock detected on commit, retrying in 1s (attempt ${commitAttempts + 1}/3)...`);
            await new Promise(r => setTimeout(r, 1000));
            commitAttempts++;
          } else {
            throw commitErr;
          }
        }
      }
    }

    // Step 2: fetch remote
    try {
      await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data']);
    } catch (fetchErr: unknown) {
      const errorMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      log.info(`[sync-watcher] fetch failed (${classifyGitError(errorMsg)}): ${errorMsg}`);
      // Push what we have locally, remote will catch up later
      try {
        await execFileAsync('git', ['-C', storeDir, 'push', 'origin', 'flux-data']);
        markSynced();
      } catch (pushErr: unknown) {
        // Both fetch and push failed. Prefer the auth-classified message so a
        // credential failure surfaces the actionable re-auth state (FLUX-895).
        const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        reportSyncFailure(classifyGitError(pushMsg) === 'auth' ? pushMsg : errorMsg, onFail);
      }
      return;
    }

    // FLUX-1426: re-check against what we just fetched — fetch only updates the remote-tracking
    // ref, so a marker bump on origin isn't visible in the Step-1 HEAD check above until it's
    // merged in. Catch it here, before Step 3's merge/ff-only would pull an incompatible
    // protocol into the worktree or Step 4 pushes on top of it.
    const remoteMarker = await readSyncProtocolMarker(storeDir, 'origin/flux-data');
    if (remoteMarker > SUPPORTED_SYNC_PROTOCOL) {
      reportProtocolMismatch(remoteMarker);
      return;
    }

    // Step 3+4 (FLUX-1428): push-as-CAS + journal replay. This REPLACES the old fetch-merge-push
    // flow — runSync never invokes `git merge` on origin/flux-data anymore. The remote is the
    // serialization point: push directly (git itself rejects a non-fast-forward push, which is
    // exactly a compare-and-swap). A clean push means nobody raced us. A rejected push means the
    // remote moved since Step 2's fetch — instead of textually merging file content, drop our
    // local commit entirely (`reset --hard` onto the new remote head) and replay this engine's own
    // not-yet-pushed mutations through the real handler (task-store's updateTaskWithHistory), so a
    // duplicate business event (e.g. "advance to Done because PR merged") converges to a no-op
    // instead of colliding as text. The old merge/conflict machinery below (resolveConflicts,
    // mergePrTicketConflict, etc.) intentionally stays in this file, unreachable from this path —
    // removed in a follow-up ticket once this is proven (see FLUX-1428's "delete nothing yet").
    for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt++) {
      // Snapshot the journal for THIS attempt before pushing — these are the ops the current local
      // HEAD carries that aren't confirmed on the remote yet. Re-read fresh each attempt (not
      // hoisted above the loop) so an entry appended mid-retry by a concurrent request is captured
      // by the attempt that actually pushes it, rather than silently skipped.
      const journalBatch = await readJournalEntries(storeDir);

      try {
        await execFileAsync('git', ['-C', storeDir, 'push', 'origin', 'flux-data']);
        log.info(`[sync-watcher] Pushed flux-data to remote (CAS, attempt ${attempt})`);
        markSynced();
        await dropFlushedJournalEntries(storeDir, journalBatch.length);
        return;
      } catch (pushErr: unknown) {
        const errorMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);

        if (!isNonFastForwardRejection(errorMsg)) {
          // Not a lost race (network/auth/unknown) — nothing to reset/replay, surface normally.
          log.info(`[sync-watcher] push failed (${classifyGitError(errorMsg)}): ${errorMsg}`);
          reportSyncFailure(errorMsg, onFail);
          return;
        }

        if (attempt >= CAS_MAX_ATTEMPTS) {
          console.error(`[sync-watcher] CAS push rejected ${CAS_MAX_ATTEMPTS} times in a row (remote kept moving) — giving up this tick.`);
          reportSyncFailure(`Sync could not converge after ${CAS_MAX_ATTEMPTS} attempts — the remote kept moving. It will retry automatically.`, onFail);
          return;
        }

        log.info(`[sync-watcher] Push rejected (remote moved) — resetting to origin/flux-data and replaying ${journalBatch.length} local op(s) (attempt ${attempt}/${CAS_MAX_ATTEMPTS})`);

        const { stdout: preResetHead } = await execFileAsync('git', ['-C', storeDir, 'rev-parse', 'HEAD']);
        await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data']);

        // FLUX-1426: re-check the freshly-fetched marker before adopting it as our new base — a
        // losing race against an engine that ALSO bumped the protocol must fence out read-only,
        // not reset onto (and start replaying against) a head we don't know how to interpret.
        const postFetchMarker = await readSyncProtocolMarker(storeDir, 'origin/flux-data');
        if (postFetchMarker > SUPPORTED_SYNC_PROTOCOL) {
          reportProtocolMismatch(postFetchMarker);
          return;
        }

        await execFileAsync('git', ['-C', storeDir, 'reset', '--hard', 'origin/flux-data']);

        // FLUX-1428 test-only hook: fires once per reset, before replay — lets a test deterministically
        // keep the remote moving (e.g. push another commit) to exercise CAS_MAX_ATTEMPTS exhaustion
        // without racing real concurrent processes against wall-clock timing. No-op in production.
        if (_testOnAfterResetHook) await _testOnAfterResetHook();

        // FLUX-1428: nothing journaled this attempt means nothing needs replaying — a raw local
        // file edit made outside updateTaskWithHistory (not a tracked intent) is, by design, simply
        // superseded by the remote's version on a lost race. Skip the cache reload + replay
        // machinery entirely in that case: it exists to give replay accurate state, and there's
        // nothing to replay. (This also means resetting to the remote head never requires a
        // replay handler to have been registered unless there's actually journaled work.)
        if (journalBatch.length > 0) {
          // Refresh the in-memory cache for exactly what the reset rewrote, BEFORE replay — replay
          // must see the winning side's fresh state, not a stale in-memory copy of what our now-
          // discarded local commit thought the ticket looked like.
          const { stdout: diffOut } = await execFileAsync('git', ['-C', storeDir, 'diff', '--name-only', preResetHead.trim(), 'origin/flux-data']).catch(() => ({ stdout: '' }));
          const changedPaths = diffOut.split('\n').map((l) => l.trim()).filter(Boolean);
          await reloadCacheAfterReset(storeDir, changedPaths);

          for (const entry of journalBatch) {
            try {
              await replayJournalEntry(entry);
            } catch (replayErr: unknown) {
              const replayMsg = replayErr instanceof Error ? replayErr.message : String(replayErr);
              console.error(`[sync-watcher] Replay failed for ${entry.taskId} (op ${entry.opId}): ${replayMsg}`);
            }
          }
        }

        // Fold the replayed mutations into a fresh local commit and loop back to push again.
        await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
        const { stdout: porcelainAfterReplay } = await execFileAsync('git', ['-C', storeDir, 'status', '--porcelain']);
        if (porcelainAfterReplay.trim()) {
          await execFileAsync('git', ['-C', storeDir, 'commit', '-m', `flux: sync (replay ${journalBatch.length} op(s))`]);
        }
        // loop continues → retry push against the new base
      }
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-watcher] sync failed: ${errorMsg}`);
    reportSyncFailure(errorMsg, onFail);
  } finally {
    syncInFlight = false;
  }
}

export function createScheduler(
  getDebounceMs: () => number,
  getMaxWaitMs: () => number,
  onSync: () => void
): { schedule: () => void; reset: () => void; scheduleRetry: (delayMs?: number) => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function schedule() {
    const now = Date.now();
    if (deadline === null) deadline = now + getMaxWaitMs();
    if (timer) clearTimeout(timer);
    const remaining = deadline - now;
    const delay = Math.min(getDebounceMs(), remaining);
    timer = setTimeout(() => {
      timer = null;
      deadline = null;
      onSync();
    }, delay);
  }

  function reset() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    deadline = null;
  }

  // Re-arm the single retry timer. Default cadence is 30s; an auth failure passes
  // AUTH_RETRY_DELAY_MS so a credential outage stops hammering every 30s (FLUX-895).
  // The `if (retryTimer) return` guard means an already-armed (e.g. slow auth)
  // retry is not shortened by a later default-cadence call.
  function scheduleRetry(delayMs: number = 30000) {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      onSync();
    }, delayMs);
  }

  return { schedule, reset, scheduleRetry };
}

export function startSyncWatcher(): void {
  stopSyncWatcher();
  if (!isOrphanMode()) return;

  const storeDir = getFluxStoreDir();

  scheduler = createScheduler(
    () => getConfig().syncSettings?.debounceMs ?? 30000,
    () => getConfig().syncSettings?.maxWaitMs ?? 300000,
    () => { void runSync(storeDir, (delayMs?: number) => scheduler?.scheduleRetry(delayMs)); }
  );

  watcher = chokidar.watch(storeDir, {
    ignored: (filePath: string) => {
      const base = path.basename(filePath);
      // FLUX-855: open-prompts.json (HITL store) is gitignored (STORE_LOCAL_IGNORES) and rewritten on
      // every prompt park/settle; watching it just wakes the sync cycle for a file that is never
      // committed. Exclude it so the HITL hot path doesn't churn the flux-data sync watcher.
      // FLUX-894: session-binding-secret is a gitignored local-only credential; never sync it.
      return base.endsWith('.tmp') || base.startsWith('.git') || base === '.git' || base === 'open-prompts.json' || base === 'session-binding-secret';
    },
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on('add', () => scheduler!.schedule());
  watcher.on('change', () => scheduler!.schedule());
  watcher.on('unlink', () => scheduler!.schedule());
  // FLUX-784: swallow recoverable watcher errors (inotify limits, transient locks) — an
  // unhandled 'error' would rethrow and the uncaughtException handler exits the engine.
  watcher.on('error', (err) => console.error('[sync-watcher] file-sync paused:', err));

  const debounceMs = getConfig().syncSettings?.debounceMs ?? 30000;
  const maxWaitMs = getConfig().syncSettings?.maxWaitMs ?? 300000;
  log.info(`[sync-watcher] Watching .flux-store/ for changes (${debounceMs / 1000}s debounce, ${maxWaitMs / 1000}s max-wait)`);

  // FLUX-1079/FLUX-1088: independent of file-change/retry-timer activity — a dismissed-but-
  // unresolved conflict or auth failure needs re-surfacing even when nothing else is nudging
  // runSync().
  resurfaceTimer = setInterval(() => {
    maybeResurfaceConflictNotification();
    maybeResurfaceAuthNotification();
  }, RESURFACE_INTERVAL_MS);
  resurfaceTimer.unref?.();
}

export function stopSyncWatcher(): void {
  if (scheduler) { scheduler.reset(); scheduler = null; }
  if (watcher) { void watcher.close(); watcher = null; }
  if (resurfaceTimer) { clearInterval(resurfaceTimer); resurfaceTimer = null; }
}
