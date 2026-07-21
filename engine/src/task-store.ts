import { getWorkspace, openWorkspace, runWithWorkspace, type Workspace } from './workspace-context.js';
import { log } from './log.js';
import { performance } from 'node:perf_hooks';
import { recordDuration } from './perf/registry.js';
import { recordFullRescan, recordWorkspaceActivation } from './perf/rescan-timing.js';
import { warnIfSlowLoadTask } from './perf/load-task-timing.js';
import { recordWatchEvent } from './perf/watch-storm.js';
import { finalMessageNeedsUser } from './final-message-heuristic.js';
import fs from 'fs/promises';
import { realpathSync, existsSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import chokidar from 'chokidar';
// FLUX-999 (epic FLUX-996): getMaxIdFromRemote's git fetch used to be a bare execFileAsync — no
// timeout, no non-interactive env — so it could hang EVERY create_ticket in orphan mode forever
// on a slow/unreachable remote or a stalled credential prompt. Route through the S1 runner.
import { runGit } from './git-exec.js';
import { getActiveFluxDir, getTaskAssetsDir, getFluxStoreDir, isOrphanMode, setWorkspaceRoot, getWorkspacesList, getWorkspaceRoot } from './workspace.js';
import { attachWorktreeIfPresent, migrateStrandedFluxTickets, ensureNonOrphanLocalGitignore } from './storage-sync.js';
import { startSyncWatcher, allocateNewTicketId, triggerSync } from './sync-watcher.js';
import { appendJournalEntry, setJournalReplayHandler, setJournalCacheReloadHandler } from './sync-journal.js';
import { randomUUID } from 'crypto';
import { loadConfig, autoRegisterUnknownTags, getConfig } from './config.js';
import { loadCustomPersonas } from './orchestration-personas.js';
import { normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry, findEarliestHistoryDate, getHistoryTimestamp, compactSessionProgress, type HistoryEntryLike } from './history.js';
import { isPidAlive } from './kill-process-tree.js';
import { generatePromptNotification, generateCompletionNotification, clearNotifications, checkSkillStaleness, addNotification } from './notifications.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { broadcastEvent, bumpTasksVersion } from './events.js';
import { rehydrateOpenPrompts } from './hitl-prompts.js';
import { cliSessionsById, cliSessionIdByTaskId, rehydrateSessionStubs, armReclaimGrace } from './session-store.js';
import { isTopLevelTaskFile, getDocsDir, isDocFile, getDocPathFromFile, titleFromDocPath, slugifyDocValue, parseDocOrder } from './file-utils.js';
import { resolveEmbeddedDocsRoot, copyDir, buildStarterProjectOverview } from './docs-seeder.js';
import { bootstrapNewWorkspace, installSkillsForWorkspace } from './bootstrap.js';
import { activateGroup, activateMemberBinding, groupDocsLabel } from './group.js';
import { attachMemberWorktree } from './group-member-worktree.js';
import { pruneTaskWorktrees } from './task-worktree.js';
import { probeAllEnabled } from './module-probe.js';
import { runWithConcurrency } from './concurrency.js';
import { loadBootIndex, partitionByBootIndex, persistBootIndex } from './boot-index.js';

// FLUX-343 (plan step 1): the pure serializer/validator/util surface moved to task-serialize.ts.
// Re-exported here so the ~60 existing importers keep one stable import path; task-store's own
// internal uses go through the import below.
export { atomicWriteFile, serializeTaskForApi, serializeTaskForAgent, serializeTaskForList, getTerminalStatuses, subtaskIds, validateParentLink, repairTicket, truncateBodyForAgent, AGENT_BODY_LIMIT, computeBodyVersion, computeDiskBodyVersion } from './task-serialize.js';
export type { TaskRecord, TaskFrontmatter } from './task-serialize.js';
import { atomicWriteFile, subtaskIds, repairTicket, computeDiskBodyVersion } from './task-serialize.js';
import type { TaskRecord, TaskFrontmatter } from './task-serialize.js';

// FLUX-343: the mutable workspace state (tasks/docs/parse-errors/isActivating) that used to be
// exported `let` singletons here now lives on the Workspace object — read it via getWorkspace()
// from workspace-context.ts.
//
// FLUX-1447 (epic FLUX-1230 S2, the routing-contract template): every stateful function below now
// takes/receives its owning `ws: Workspace` instead of calling the bare global `getWorkspace()`
// internally. Exported functions default `ws: Workspace = getWorkspace()` so the ~250 not-yet-
// migrated external call sites (across 44 other files — MCP tools/S3, background jobs/S4, the many
// `updateTaskWithHistory`/`createTask` callers) keep compiling and behaving byte-for-byte unchanged;
// a caller that HAS already resolved a workspace (an HTTP route reading `req.workspace`, or another
// task-store function that already has `ws` in scope) passes it explicitly instead of triggering a
// second, potentially-divergent lookup. Internal-only helpers (no external callers) take a required
// `ws` threaded from their one caller — no default needed since we control every call site directly.
// `activateWorkspace`/`doActivateWorkspace` are the deliberate exception: they resolve `getWorkspace()`
// ONCE at the activation entry point and thread that single `ws` through the rest of the activation
// call graph, but do not route through the S1 registry (`openWorkspace`) themselves — rewiring
// *activation* to open/target a specific registry entry is a separate decision (not owned by any S2
// coverage-map row) left to a later subtask.

// FLUX-1547: bounded concurrency for the boot scan (both the boot-index stat-comparison pass and
// the full loadTask pool). 12 in-flight files overlaps I/O round-trips well without creating so
// many simultaneous fs handles that it risks EMFILE on a constrained host.
const BOOT_SCAN_CONCURRENCY = 12;
// How often (in newly-*fully*-loaded files, not cache hits) to broadcast `bootProgress` while the
// full-load pool is running. Lower than the old RESCAN_YIELD_EVERY (50) since parallel loads
// finish out of order — a tighter cadence keeps the portal's progress count reading as continuous
// instead of jumping in large steps (FLUX-1547 Phase 4 tweens on top of this on the portal side).
const BOOT_PROGRESS_EVERY = 10;

const repairingPaths = new Set<string>();

// Paths the engine just wrote itself. atomicWriteFile (temp + rename) fires a
// chokidar 'change'/'add' for the .md, which would re-run loadTask on content
// the engine already has in cache. Each guarded write adds its path here; the
// next watcher-driven loadTask for that path consumes the entry and skips the
// redundant stat/read/parse/validate pass (FLUX-290). Single-fire on purpose —
// only the engine's own follow-up event is swallowed, not later external edits.
const recentEngineWrites = new Set<string>();

// Sessions whose final message we've already surfaced as a notification (FLUX-570) —
// dedup across the multiple terminal persists a single session can make.
// FLUX-1445: only ever grew (no .delete()) — with N workspaces sharing this process, every
// session across every board goes in and none come out. Capped FIFO: a session's terminal
// persists all happen close together, so evicting the oldest entry once the cap is hit can
// only reopen dedup for a session that's long since finished flushing.
const SURFACED_FINAL_MESSAGES_MAX = 1000;
const surfacedFinalMessages = new Set<string>();

function markFinalMessageSurfaced(sessionId: string) {
  surfacedFinalMessages.add(sessionId);
  if (surfacedFinalMessages.size > SURFACED_FINAL_MESSAGES_MAX) {
    const oldest = surfacedFinalMessages.values().next().value;
    if (oldest !== undefined) surfacedFinalMessages.delete(oldest);
  }
}

export async function readTaskFromDisk(task: TaskRecord): Promise<{ frontmatter: TaskFrontmatter; body: string }> {
  const fallbackFromCache = () => {
    const { body: cachedBody, _path: _p, id: _id, ...cachedFm } = task;
    return { frontmatter: { ...cachedFm }, body: cachedBody || '' };
  };

  try {
    const rawFile = await fs.readFile(task._path, 'utf-8');
    if (!rawFile || !rawFile.trim()) {
      console.warn(`[readTaskFromDisk] Empty file read for ${task.id}, using cache`);
      return fallbackFromCache();
    }
    const parsed = matter(rawFile);
    // Guard: if the file lost its title, it's a partial/corrupt read — use cache
    if (!parsed.data.title && task.title) {
      console.warn(`[readTaskFromDisk] Corrupt read for ${task.id} (missing title), using cache`);
      return fallbackFromCache();
    }
    return { frontmatter: { ...parsed.data }, body: parsed.content || '' };
  } catch {
    return fallbackFromCache();
  }
}

function recoverSessionEntry(taskId: string, sessionId: string, task: TaskRecord) {
  const liveSessionId = cliSessionIdByTaskId.get(taskId);
  const liveSession = liveSessionId ? cliSessionsById.get(liveSessionId) : undefined;
  if (liveSession?.sessionHistoryEntry?.sessionId === sessionId) {
    log.info(`updateAgentSession: re-injected session ${sessionId} (agent dropped it from file)`);
    return { ...liveSession.sessionHistoryEntry };
  }

  const cachedHistory = Array.isArray(task.history) ? task.history : [];
  const cachedEntry = cachedHistory.find((e) => e?.type === 'agent_session' && e?.sessionId === sessionId);
  if (cachedEntry) {
    log.info(`updateAgentSession: re-injected session ${sessionId} from cache`);
    return { ...cachedEntry };
  }

  return null;
}

// FLUX-992: routes through the same per-ticket write lock as updateTaskWithHistory. This function
// does its own read-modify-write of the full frontmatter (not just the touched history entry), so
// without the lock a concurrent write to any other field (e.g. swimlane set by change_status) could
// read stale frontmatter here and get silently reverted when this write lands after.
export function updateAgentSession(taskId: string, sessionId: string, updater: (session: Record<string, unknown>) => void, ws: Workspace = getWorkspace()) {
  return serializeTicketWrite(ws, taskId, () => updateAgentSessionLocked(taskId, sessionId, updater, ws));
}

async function updateAgentSessionLocked(taskId: string, sessionId: string, updater: (session: Record<string, unknown>) => void, ws: Workspace) {
  const task = ws.tasks[taskId];
  if (!task) return null;

  const { frontmatter, body } = await readTaskFromDisk(task);
  const history = Array.isArray(frontmatter.history) ? frontmatter.history : [];
  let sessionIndex = history.findIndex((entry) => entry?.type === 'agent_session' && entry?.sessionId === sessionId);

  if (sessionIndex === -1) {
    const recovered = recoverSessionEntry(taskId, sessionId, task);
    if (!recovered) {
      console.warn(`updateAgentSession: session ${sessionId} not found in task ${taskId} (not recoverable)`);
      return null;
    }
    history.push(recovered);
    sessionIndex = history.length - 1;
  }

  updater(history[sessionIndex]);
  // Every adapter persists its terminal state through here — compact the
  // per-second progress chunks once the session leaves 'active'.
  compactSessionProgress(history[sessionIndex]);

  // FLUX-570/777/945 safety-net: if a session ended with a final message that reads like it needs
  // the user's input, but the agent did NOT route it to the board (no require-input swimlane),
  // surface it — so a blocking question can't die silently in the session log (as happened on the
  // FLUX-556 finalize). The heuristic (extracted + unit-tested in final-message-heuristic.ts) keeps
  // the FLUX-777 "looks done" false-positive guard BUT lets a TRAILING question override it: an
  // agent that summarizes what it did AND then asks "…or leave it?" (FLUX-941) must not be buried.
  // Deduped per session.
  const sess = history[sessionIndex];
  if (sess?.status && sess.status !== 'active' && sess.finalMessage && !surfacedFinalMessages.has(sessionId)) {
    const fm = String(sess.finalMessage);
    if (finalMessageNeedsUser(fm, frontmatter.swimlane)) {
      markFinalMessageSurfaced(sessionId);
      // FLUX-945: raise the PERSISTENT needsAction flag in addition to the transient notification, so
      // the question survives even when the same session moved the ticket to a terminal status (Done/
      // Ready) — a notification alone evaporates the moment the user looks away. Set inline: we are
      // already mutating + persisting `frontmatter` below, so this avoids a re-entrant ticket write.
      if (!frontmatter.needsAction) {
        frontmatter.needsAction = `Agent may need your input: ${fm.length > 200 ? fm.slice(0, 200) + '…' : fm}`;
      }
      addNotification({
        type: 'prompt',
        title: `${taskId}: agent may need your input`,
        message: fm.length > 280 ? fm.slice(0, 280) + '…' : fm,
        ticketId: taskId,
        actions: [{ label: 'View ticket', actionId: 'view' }],
      });
    }
  }

  frontmatter.history = history;
  frontmatter.updatedBy = 'Agent';

  const fileContent = matter.stringify(body, frontmatter);
  recentEngineWrites.add(task._path);
  await atomicWriteFile(task._path, fileContent);
  ws.tasks[taskId] = { ...frontmatter, body, id: taskId, _path: task._path };
  return ws.tasks[taskId];
}

// Per-ticket write serialization (FLUX-645). With a single shared MCP server, concurrent
// sessions issue concurrent read-modify-write on a ticket's history; without a lock the later
// write reads stale frontmatter and clobbers the earlier append, dropping history entries. A
// per-(workspace, ticketId) promise chain serializes writes to the SAME ticket in the SAME
// workspace while writes to different tickets — or the same ticket id in a different workspace —
// stay parallel. (One engine process finally makes this enforceable — the old N-stdio-servers
// design couldn't share a lock.)
// FLUX-1451: keyed by `Workspace` object identity (outer WeakMap) rather than a bare ticket id —
// with N workspaces sharing this process, ticket ids collide across boards (each board's own
// "FLUX-1"), so an id-only key would serialize unrelated writes against each other. Object
// identity has no null-`root`-before-first-bind case and no string-separator collision risk, and
// the inner map is dropped for free (WeakMap GC) once a workspace is evicted from the registry.
const ticketWriteChains = new WeakMap<Workspace, Map<string, Promise<unknown>>>();

function serializeTicketWrite<T>(ws: Workspace, taskId: string, run: () => Promise<T>): Promise<T> {
  let chains = ticketWriteChains.get(ws);
  if (!chains) {
    chains = new Map<string, Promise<unknown>>();
    ticketWriteChains.set(ws, chains);
  }
  const prev = chains.get(taskId) ?? Promise.resolve();
  // Chain onto the previous write whether it resolved or rejected, so one failed write
  // doesn't wedge the queue for that ticket.
  const result = prev.then(run, run);
  // Keep a non-rejecting tail as the chain head, and prune the map entry once this is the
  // last write in flight so the map doesn't grow unbounded across many tickets.
  const tail = result.then(() => {}, () => {});
  chains.set(taskId, tail);
  void tail.then(() => {
    if (chains!.get(taskId) === tail) chains!.delete(taskId);
  });
  return result;
}

/**
 * FLUX-1550: thrown by `updateTaskWithHistoryLocked` when a body write's `baseBodyVersion` no
 * longer matches the on-disk body's current version — a lost-update race (someone else wrote the
 * body between this caller's read and this write). Carries the fresh on-disk version so the
 * caller can re-read and retry without a second round trip just to discover the new token.
 */
export class StaleBodyError extends Error {
  currentBodyVersion: string;
  constructor(currentBodyVersion: string) {
    super('Ticket body changed since it was last read (stale baseBodyVersion) — re-read the ticket and retry.');
    this.name = 'StaleBodyError';
    this.currentBodyVersion = currentBodyVersion;
  }
}

// FLUX-1550: bounded recoverability stash for body overwrites. A CAS rejection (StaleBodyError)
// never touches disk — nothing to recover there. This covers the writes that DO land: a matching-
// version write, and the deliberate grandfathered-omission hole (AC #4/#7) — so even a
// no-token overwrite is recoverable without spelunking a session's JSONL transcript. Capped FIFO
// per ticket; a sidecar JSON file next to the ticket's own .md, never synced/committed as ticket
// content itself.
const BODY_HISTORY_MAX_ENTRIES = 20;

async function stashPriorBody(ticketPath: string, priorBody: string): Promise<void> {
  const historyPath = ticketPath.replace(/\.md$/, '.body-history.json');
  try {
    let entries: Array<{ body: string; version: string; ts: string }> = [];
    try {
      const raw = await fs.readFile(historyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
    entries.push({ body: priorBody, version: computeDiskBodyVersion(priorBody), ts: new Date().toISOString() });
    if (entries.length > BODY_HISTORY_MAX_ENTRIES) entries = entries.slice(-BODY_HISTORY_MAX_ENTRIES);
    await fs.writeFile(historyPath, JSON.stringify(entries), 'utf-8');
  } catch (err) {
    // Recoverability is best-effort — never block or fail the actual ticket write over it.
    console.warn(`[FLUX] Failed to stash prior body for ${ticketPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface UpdateTaskWithHistoryOptions {
  entries?: unknown[];
  updatedBy?: string;
  nextStatus?: string;
  extraFields?: Record<string, unknown>;
  // FLUX-1068: frontmatter keys to REMOVE (not just null out) — e.g. detaching a parent should
  // delete `parentId` entirely, matching the REST PUT route rather than persisting `parentId: null`.
  deleteFields?: string[];
  // FLUX-788: opt-in title/body replacement so metadata-edit callers (update_ticket) can route
  // through this locked + atomic path. Both default to "keep what's on disk" — existing callers
  // are unaffected. `newTitle` is honored here because extraFields deliberately strips `title`.
  newTitle?: string;
  newBody?: string;
  // FLUX-1550: opaque `computeBodyVersion` token the caller read alongside the body it's basing
  // `newBody` on. Only meaningful together with `newBody` — ignored for metadata-only writes.
  // Matches the fresh on-disk version → write proceeds. Mismatches → rejected with
  // `StaleBodyError` instead of clobbering. Omitted entirely → grandfathered (today's pre-CAS
  // behavior), logged via console.warn so the hole stays visible.
  baseBodyVersion?: string;
  tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated: boolean; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
  // FLUX-987: append this child ticket id to frontmatter.subtasks. Computed from the FRESH
  // on-disk array read under THIS lock acquisition (not a precomputed array passed via
  // extraFields) — a concurrent write to the same parent (add_note/change_status/another
  // create_ticket) can't clobber this addition, which is exactly the race this option closes.
  appendSubtask?: string;
  // FLUX-1428: set true for engine-derived writes (PR-poller GitHub field mirrors, digests —
  // anything recomputable from source-of-truth, not authored by a human/agent). Derived writes are
  // never journaled: on a lost sync race they're simply re-derived against the new head instead of
  // replayed, per the field-ownership taxonomy in FLUX-1427/1428.
  derived?: boolean;
  // FLUX-1428: dedup key for an externally-triggered intent (e.g. `pr-42-merged`, `ci-<sha>-pass`).
  // If any entry already in the ticket's history carries this key, the whole call is a no-op — so
  // the losing side of a sync race replaying "PR merged, advance to Done" against a head that
  // already has that exact key applied converges cleanly instead of double-posting. Stamped onto
  // the first pushed history entry when the call actually applies. Human/agent-authored writes
  // (comments, manual status moves) need no key — they were genuinely discarded by a lost race and
  // replaying them is a real addition, not a duplicate.
  idempotencyKey?: string;
  // FLUX-1428: internal — set by the sync-watcher replay loop when re-invoking this call for an
  // already-journaled entry, so the replay itself doesn't get journaled again.
  __replaying?: boolean;
}

export function updateTaskWithHistory(taskId: string, options: UpdateTaskWithHistoryOptions, ws: Workspace = getWorkspace()) {
  return serializeTicketWrite(ws, taskId, () => updateTaskWithHistoryLocked(taskId, options, ws));
}

// FLUX-1428: register this as the journal's replay entry point. sync-watcher.ts can't statically
// import task-store.ts (task-store.ts already imports FROM sync-watcher.ts) — the indirection
// avoids the cycle while keeping replay routed through the real handler, not a raw file write.
setJournalReplayHandler((taskId, options) => updateTaskWithHistory(taskId, options as UpdateTaskWithHistoryOptions));
// FLUX-1428: same indirection for the post-`reset --hard` cache reload the CAS loop needs before
// replaying — reconcileBackgroundPull already does exactly this (re-load changed files, drop
// deleted ones) for the chokidar background-pull path; reuse it rather than duplicating the logic.
setJournalCacheReloadHandler(reconcileBackgroundPull);

async function updateTaskWithHistoryLocked(taskId: string, options: UpdateTaskWithHistoryOptions, ws: Workspace) {
  const task = ws.tasks[taskId];
  if (!task) return null;

  const actor = options.updatedBy || task.updatedBy || 'Agent';
  const activityTimestamp = new Date().toISOString();
  const entries = Array.isArray(options.entries) ? [...options.entries] : [];
  const { _path } = task;

  const { frontmatter, body } = await readTaskFromDisk(task);

  // FLUX-1550: body CAS. Only gates writes that actually replace the body (`newBody` present) —
  // metadata-only writes (extraFields/nextStatus/etc. with no newBody) are unaffected regardless
  // of what `baseBodyVersion` carries. Must run BEFORE any frontmatter mutation below so a
  // rejected write leaves the on-disk ticket completely untouched.
  if (options.newBody !== undefined) {
    const currentBodyVersion = computeDiskBodyVersion(body);
    if (options.baseBodyVersion !== undefined) {
      if (options.baseBodyVersion !== currentBodyVersion) {
        throw new StaleBodyError(currentBodyVersion);
      }
    } else {
      // Grandfathered: no token sent, keep today's pre-CAS behavior but make the hole visible.
      console.warn(`[FLUX] Body overwrite for ${taskId} carried no baseBodyVersion (grandfathered) — proceeding without a conflict check.`);
    }
  }

  const normalizedExistingHistory = normalizeHistoryEntries(Array.isArray(frontmatter.history) ? frontmatter.history : []);

  // FLUX-1428: idempotency dedup — applies to BOTH a fresh call and a replay. If this exact
  // externally-triggered intent already landed (its key is already on some history entry), every
  // further attempt (a retriggered poll, or a replay after a lost sync race) is a clean no-op:
  // return the unchanged task without journaling or writing anything.
  if (options.idempotencyKey) {
    const alreadyApplied = normalizedExistingHistory.history.some(
      (e) => e && typeof e === 'object' && (e as Record<string, unknown>).idempotencyKey === options.idempotencyKey,
    );
    if (alreadyApplied) return task;
  }

  // FLUX-1428: durable journal write MUST complete before the mutation below touches disk — that
  // ordering is what makes replay-after-`reset --hard` safe (see sync-journal.ts's header comment).
  // Skipped for derived writes (never replayed) and for the replay call itself (already journaled
  // once; replaying it again would grow the journal forever and re-replay on every future tick).
  if (!options.derived && !options.__replaying && isOrphanMode()) {
    const { __replaying: _r, derived: _d, ...journaledOptions } = options;
    await appendJournalEntry(getFluxStoreDir(), {
      opId: randomUUID(),
      taskId,
      ts: activityTimestamp,
      options: journaledOptions as Record<string, unknown>,
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
  }

  let nextHistory = ensureCreationActivity(
    normalizedExistingHistory.history,
    frontmatter.createdBy || actor,
    findEarliestHistoryDate(normalizedExistingHistory.history),
  ).history;

  if (options.nextStatus && frontmatter.status !== options.nextStatus) {
    // FLUX-1044: the REST PUT route (now routed through this helper too) can already carry a
    // matching status_change among its entries — the portal's FLUX-725 writers send the move
    // (with its required comment) as an appendHistory delta, and a stale full-history submission
    // can contain one as well (FLUX-1311). Only auto-append the fallback entry when none of the
    // caller's entries records this exact transition, so a portal move doesn't get a second,
    // comment-less duplicate. MCP callers never pass status_change entries, so this is a no-op
    // for them.
    const callerRecordedMove = entries.some((raw) => {
      const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
      return e?.type === 'status_change' && e?.from === frontmatter.status && e?.to === options.nextStatus;
    });
    if (!callerRecordedMove) {
      entries.push({
        type: 'status_change',
        from: frontmatter.status,
        to: options.nextStatus,
        user: actor,
        date: activityTimestamp,
      });
    }
    frontmatter.status = options.nextStatus;
    // FLUX-651: any real status move is a board action — clear the "agent parked" flag so the
    // ticket stops showing as Needs Action (covers the agent advancing it AND the user moving
    // the card via the board). Skip when extraFields explicitly sets needsAction (the backstop).
    if (!(options.extraFields && 'needsAction' in options.extraFields)) {
      frontmatter.needsAction = null;
    }
  }

  // FLUX-1428: stamp the dedup key onto the first entry this call actually pushes, so a future
  // call (retriggered poll, or journal replay) can find it via the idempotencyKey scan above.
  if (options.idempotencyKey && entries.length > 0 && entries[0] && typeof entries[0] === 'object') {
    (entries[0] as Record<string, unknown>).idempotencyKey = options.idempotencyKey;
  }

  nextHistory = normalizeHistoryEntries([...nextHistory, ...entries]).history;
  frontmatter.history = nextHistory;
  frontmatter.updatedBy = actor;

  if (options.extraFields) {
    const { id: _i, title: _t, history: _h, _path: _pp, ...safeFields } = options.extraFields;
    Object.assign(frontmatter, safeFields);
    // FLUX-651: raising the Require Input swimlane is a board action too — clear any parked flag.
    if (safeFields.swimlane === 'require-input' && !('needsAction' in safeFields)) {
      frontmatter.needsAction = null;
    }
  }

  // FLUX-1068: remove keys outright (e.g. detach a parent by deleting `parentId`) — id/title/history
  // are load-bearing and never deletable through this path.
  if (options.deleteFields) {
    for (const field of options.deleteFields) {
      if (field === 'id' || field === 'title' || field === 'history') continue;
      delete frontmatter[field];
    }
  }

  // FLUX-788: explicit title replacement (extraFields strips `title` to prevent accidental loss).
  if (options.newTitle !== undefined) frontmatter.title = options.newTitle;
  // FLUX-788: explicit body replacement; otherwise keep whatever was on disk.
  const useBody = options.newBody !== undefined ? options.newBody : body;

  if (options.tokenMetadata) {
    frontmatter.tokenMetadata = options.tokenMetadata;
  }

  // FLUX-987: read-modify-write frontmatter.subtasks off the frontmatter this lock acquisition
  // just read fresh from disk above — not off a value the caller captured before entering the
  // lock — so a concurrent write to the same parent can't drop this addition (or vice versa).
  if (options.appendSubtask) {
    const subtasks = subtaskIds(frontmatter.subtasks);
    if (!subtasks.includes(options.appendSubtask)) subtasks.push(options.appendSubtask);
    frontmatter.subtasks = subtasks;
  }

  // Ensure id is present — some tickets derive it from filename rather than frontmatter
  if (!frontmatter.id) frontmatter.id = taskId;

  if (!frontmatter.title) {
    console.error(`[FLUX] Refusing to write ${_path}: missing title in frontmatter. This indicates a bug or race condition.`);
    return null;
  }

  // FLUX-1550: stash the outgoing body before it's overwritten, whenever the body is actually
  // changing — including the grandfathered/no-token path, which is the one CAS deliberately still
  // lets clobber. A CAS rejection never reaches this line (thrown above), so nothing is stashed
  // for a write that never landed. Best-effort; never blocks the real write.
  if (options.newBody !== undefined && options.newBody !== body) {
    await stashPriorBody(_path, body);
  }

  const fileContent = matter.stringify(useBody || '', frontmatter);
  recentEngineWrites.add(_path);
  await atomicWriteFile(_path, fileContent);
  ws.tasks[taskId] = { ...frontmatter, body: useBody, id: taskId, _path };

  if (options.nextStatus) {
    const requireInputStatus = getConfig().requireInputStatus || 'Require Input';
    const readyStatus = getConfig().readyForMergeStatus || 'Ready';
    // FLUX-1555: pass `ws` explicitly — this write already has the record's OWNING workspace in
    // scope (the `ws` param above), which can differ from whatever board is ambiently active (a
    // background loop calling `updateTaskWithHistory(id, opts, ws)` for a non-active board). Relying
    // on the notification generators' ambient `getWorkspace()` default would misroute the toast.
    if (options.nextStatus === requireInputStatus || options.nextStatus === readyStatus) {
      generatePromptNotification(taskId, frontmatter.title || taskId, options.nextStatus, ws);
    } else if (options.nextStatus === 'Done') {
      generateCompletionNotification(taskId, frontmatter.title || taskId, ws);
    }
  }

  return ws.tasks[taskId];
}

/**
 * Bidirectional parentId ⇄ parent.subtasks sync (FLUX-1068). When a ticket's `parentId` and/or
 * `subtasks` changed, update the OTHER affected tickets on disk + cache: the old/new parent's
 * `subtasks` array, and any added/removed child's `parentId`. The ticket itself is written by the
 * caller — this only reconciles its relations. Shared by the REST PUT route (`routes/tasks.ts`) and
 * the MCP `update_ticket` tool so the link invariant has ONE implementation (no duplicated logic).
 */
export async function syncParentSubtaskLinks(opts: {
  id: string;
  oldParentId: string | null;
  newParentId: string | null;
  oldSubtasks?: string[];
  newSubtasks?: string[];
  actor: string;
}, ws: Workspace = getWorkspace()): Promise<void> {
  const { id, oldParentId, newParentId, actor } = opts;
  const oldSubtasks = opts.oldSubtasks ?? [];
  const newSubtasks = opts.newSubtasks ?? [];

  const writeParentSubtasks = async (parentId: string, subtasks: string[]) => {
    const parent = ws.tasks[parentId];
    if (!parent) return;
    const parentRaw = await fs.readFile(parent._path, 'utf-8');
    const parentParsed = matter(parentRaw);
    parentParsed.data.subtasks = subtasks;
    parentParsed.data.updatedBy = actor;
    recentEngineWrites.add(parent._path);
    await atomicWriteFile(parent._path, matter.stringify(parentParsed.content, parentParsed.data));
    ws.tasks[parentId] = { ...ws.tasks[parentId], subtasks, updatedBy: actor };
    broadcastEvent('taskUpdated', { id: parentId });
  };

  const writeChildParent = async (childId: string, parentId: string | null) => {
    const child = ws.tasks[childId];
    if (!child) return;
    const childRaw = await fs.readFile(child._path, 'utf-8');
    const childParsed = matter(childRaw);
    if (parentId) childParsed.data.parentId = parentId;
    else delete childParsed.data.parentId;
    childParsed.data.updatedBy = actor;
    recentEngineWrites.add(child._path);
    await atomicWriteFile(child._path, matter.stringify(childParsed.content, childParsed.data));
    ws.tasks[childId] = { ...ws.tasks[childId], parentId: parentId ?? undefined, updatedBy: actor };
    broadcastEvent('taskUpdated', { id: childId });
  };

  // parentId changed → remove from old parent's subtasks, add to new parent's subtasks.
  if (newParentId !== oldParentId) {
    if (oldParentId && ws.tasks[oldParentId]) {
      const cur = subtaskIds(ws.tasks[oldParentId].subtasks);
      const filtered = cur.filter((sid) => sid !== id);
      if (filtered.length !== cur.length) await writeParentSubtasks(oldParentId, filtered);
    }
    if (newParentId && ws.tasks[newParentId]) {
      const cur = subtaskIds(ws.tasks[newParentId].subtasks);
      if (!cur.includes(id)) await writeParentSubtasks(newParentId, [...cur, id]);
    }
  }

  // subtasks array changed → sync each added/removed child's parentId.
  const removedChildren = oldSubtasks.filter((sid) => !newSubtasks.includes(sid));
  const addedChildren = newSubtasks.filter((sid) => !oldSubtasks.includes(sid));

  for (const childId of removedChildren) {
    const child = ws.tasks[childId];
    if (child && child.parentId === id) await writeChildParent(childId, null);
  }
  for (const childId of addedChildren) {
    const child = ws.tasks[childId];
    if (child && child.parentId !== id) {
      // Remove the child from its previous parent's subtasks before re-linking it here.
      if (child.parentId && ws.tasks[child.parentId]) {
        const prev = subtaskIds(ws.tasks[child.parentId].subtasks).filter((sid) => sid !== childId);
        await writeParentSubtasks(child.parentId, prev);
      }
      await writeChildParent(childId, id);
    }
  }
}

export interface CreateTaskOptions {
  title: string;
  status?: string;
  priority?: string;
  effort?: string;
  assignee?: string;
  tags?: string[];
  body?: string | undefined;
  author?: string;
  projectKey?: string;
  parentId?: string;
  /**
   * Typed relationships to other tickets (FLUX-593, first instance of the FLUX-596 epic):
   * e.g. a retry ticket carries `[{ type: 'retries', target: 'PR-14', label: 'PR #14' }]`.
   * Persisted verbatim into frontmatter; serializers spread it through to portal + agents.
   */
  links?: Array<{ type: string; target: string; label?: string }>;
  /**
   * FLUX-1225: ticket kind. Omitted/`'ticket'` = a normal board ticket. `'scratch'` = a freeform
   * Scratch Chat: it gets its own `SCRATCH-n` id namespace (never consumes the `FLUX-n` sequence)
   * and is hidden from board columns + the `list_tickets` active-default screen. `'pr'` tickets are
   * minted by the engine via `upsertManagedTicket`, not this path.
   */
  kind?: string;
  /**
   * Suppress the `taskCreated` broadcast inside createTask so a caller doing
   * follow-up writes (e.g. create_subtask's parent-linking) can broadcast only
   * after every write succeeds — avoids emitting an event for an orphan child
   * if a later write fails (FLUX-435).
   */
  skipBroadcast?: boolean;
}

export interface CreateTaskResult {
  id: string;
  task: TaskRecord;
}

async function getMaxIdFromRemote(projectKey: string): Promise<number> {
  if (!isOrphanMode()) return 0;

  const storeDir = getFluxStoreDir();
  try {
    // FLUX-1417: don't `git fetch` on the mint hot path — it contends with the background
    // sync pipeline's own git operations under load (both hit the repo lock) and adds
    // seconds of latency to every ticket create. Read `origin/flux-data` as last synced by
    // the periodic background sync (sync-watcher.ts runSync) instead; it's fresh enough to
    // guide id allocation, and the store's merge/reconcile on the next sync resolves any
    // residual cross-machine collision — the same guarantee normal-ticket mints already rely on.
    const { stdout } = await runGit(['ls-tree', '-r', '--name-only', 'origin/flux-data'], { cwd: storeDir });

    let maxId = 0;
    stdout.split('\n').forEach(file => {
      const fileName = path.basename(file);
      if (fileName.startsWith(`${projectKey}-`) && fileName.endsWith('.md')) {
        const idPart = fileName.replace(`${projectKey}-`, '').replace('.md', '');
        const num = parseInt(idPart, 10);
        if (!isNaN(num) && num > maxId) maxId = num;
      }
    });

    return maxId;
  } catch (err) {
    console.warn(`[tasks] Could not check remote for max ticket ID: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function createTask(options: CreateTaskOptions, ws: Workspace = getWorkspace()): Promise<CreateTaskResult> {
  const pKey = options.projectKey || getConfig().projects?.[0] || 'FLUX';
  // FLUX-1225: scratch chats live in their own `SCRATCH-n` id namespace so they never consume the
  // `FLUX-n` sequence and are trivially distinguishable from board tickets. The counter is scanned
  // (cache + remote) against this prefix, so scratch and project ids increment independently.
  const idPrefix = options.kind === 'scratch' ? 'SCRATCH' : pKey;
  let maxId = 0;
  Object.keys(ws.tasks).forEach((key) => {
    if (key.startsWith(`${idPrefix}-`)) {
      const num = parseInt(key.replace(`${idPrefix}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });

  if (isOrphanMode()) {
    const remoteMaxId = await getMaxIdFromRemote(idPrefix);
    maxId = Math.max(maxId, remoteMaxId);
    if (remoteMaxId > 0) {
      log.info(`[tasks] Remote max ID for ${idPrefix}: ${remoteMaxId}, using ${maxId + 1}`);
    }
  }

  const nextId = `${idPrefix}-${maxId + 1}`;
  const filePath = path.join(getActiveFluxDir(), `${nextId}.md`);
  const createdAt = new Date().toISOString();
  const actor = options.author || 'Unknown';

  const normalizedHistory = normalizeHistoryEntries([]);
  const historyWithCreation = options.parentId
    ? { history: [{ type: 'activity', user: actor, date: createdAt, comment: `Created as subtask of ${options.parentId}.` }], changed: true }
    : ensureCreationActivity(normalizedHistory.history, actor, createdAt);

  // FLUX-1417: name scratch chats server-side so the portal doesn't need a follow-up rename
  // round-trip before it can open the window. Only takes over the placeholder title the
  // dock sends ('Scratch') or no title at all — an explicit custom title still wins.
  const resolvedTitle = options.kind === 'scratch' && (!options.title || options.title === 'Scratch')
    ? `Scratch ${maxId + 1}`
    : (options.title || 'New Task');

  const frontmatter = {
    id: nextId,
    title: resolvedTitle,
    status: options.status || 'Todo',
    priority: options.priority || 'None',
    effort: options.effort || 'None',
    assignee: options.assignee || 'unassigned',
    tags: options.tags || [],
    createdBy: actor,
    updatedBy: actor,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.parentId && { parentId: options.parentId }),
    ...(options.links && options.links.length > 0 ? { links: options.links } : {}),
    history: historyWithCreation.history,
  };

  const validationErrors = validateTicketFrontmatter(frontmatter);
  if (validationErrors.length > 0) {
    throw new Error(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`);
  }

  if (frontmatter.tags.length > 0) {
    await autoRegisterUnknownTags(frontmatter.tags);
  }

  const body = options.body || '';
  const fileContent = matter.stringify(body, frontmatter);
  recentEngineWrites.add(filePath);
  await atomicWriteFile(filePath, fileContent);
  ws.tasks[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
  if (!options.skipBroadcast) {
    broadcastEvent('taskCreated', { id: nextId, ...(options.parentId && { parentId: options.parentId }) });
  }

  return { id: nextId, task: ws.tasks[nextId] };
}

/**
 * Hard-delete a task: remove its `.md` file from disk and drop it from the cache.
 * Mirrors the inline deletion in the DELETE /api/tasks/:id route, but WITHOUT any
 * worktree/branch teardown — this primitive is for tickets that were never given a
 * branch (e.g. a freshly created card we need to roll back). Best-effort and quiet:
 * a missing file/cache entry is not an error (the caller may be compensating). Used by
 * `extractTicket` (FLUX-738) to remove an orphan card when the curation op fails to persist.
 */
export async function deleteTask(id: string, ws: Workspace = getWorkspace()): Promise<void> {
  const task = ws.tasks[id];
  delete ws.tasks[id];
  if (task?._path) {
    await fs.unlink(task._path).catch(() => {});
  }
  // FLUX-753: tell connected portals to drop the card. Without this, the extractTicket
  // compensation path (and any other deleteTask caller) left a phantom card until reload.
  if (task) broadcastEvent('taskDeleted', { id });
}


/**
 * Engine-managed upsert for synthetic, non-hand-authored tickets — the PR tickets EH
 * derives from gh (FLUX-566). Creates `<id>.md` (or updates it) with `fields`, preserving
 * any existing history and minting a creation entry for new ones. **Idempotent + quiet:**
 * if every provided field already matches, it does nothing (no write, no broadcast) — so
 * the 90s sync doesn't churn the file or spam the portal. Uses the same `recentEngineWrites`
 * guard as other engine writes so the watcher doesn't echo it back.
 */
export async function upsertManagedTicket(
  id: string,
  fields: Record<string, unknown>,
  body = '',
  ws: Workspace = getWorkspace(),
): Promise<{ task: TaskRecord; created: boolean; changed: boolean }> {
  const existing = ws.tasks[id];
  const fieldsChanged = !existing || Object.entries(fields).some(([k, v]) => JSON.stringify(existing[k]) !== JSON.stringify(v));
  // A non-empty `body` that differs forces a rewrite (e.g. a gh PR description changed but no
  // field did — FLUX-751). An empty `body` arg never marks changed: it means "keep existing
  // body", so the many callers that omit body don't churn every managed ticket each poll.
  const bodyChanged = body !== '' && body !== (existing?.body ?? '');
  const changed = !existing || fieldsChanged || bodyChanged;
  if (existing && !changed) return { task: existing, created: false, changed: false };

  // FLUX-1579: resolve a NEW ticket's path via `ws`'s own store, never the ambient
  // `getActiveFluxDir()` — the reconcile fan-out in index.ts invokes this once per live
  // workspace inside one tick, and an unbound `getActiveFluxDir()` resolves to whichever
  // board is ambiently active, not `ws`. Binding through `runWithWorkspace` guarantees a
  // background tick for board B creates B's new PR-<n> card in B's own store even while
  // board A is the ambiently active one (the HomeUp PR #90 → EH PR-90.md incident).
  const filePath = existing?._path || path.join(runWithWorkspace(ws, () => getActiveFluxDir()), `${id}.md`);

  // Defensive check (FLUX-1579): a brand-new ticket whose resolved path already exists on
  // disk means `ws.tasks` disagrees with the store — refuse rather than blind-overwrite a
  // file that may belong to a different ticket/board entirely.
  if (!existing && existsSync(filePath)) {
    log.warn(`[upsertManagedTicket] refusing to create ${id} — ${filePath} already exists on disk but is absent from ws.tasks (store/memory mismatch)`);
    throw new Error(`upsertManagedTicket: refusing to overwrite existing file ${filePath} for untracked ticket ${id}`);
  }

  const now = new Date().toISOString();
  const history = Array.isArray(existing?.history) && existing.history.length > 0
    ? existing.history
    : [{ type: 'activity', user: 'Agent', date: now, comment: 'Created (engine-managed).' }];
  const base = existing ? (() => { const { body: _b, _path: _p, ...fm } = existing; return fm; })() : {};
  const frontmatter = { ...base, ...fields, id, history, updatedBy: 'Agent' };
  const useBody = body || existing?.body || '';

  recentEngineWrites.add(filePath);
  await atomicWriteFile(filePath, matter.stringify(useBody, frontmatter));
  ws.tasks[id] = { ...frontmatter, body: useBody, id, _path: filePath };
  broadcastEvent(existing ? 'taskUpdated' : 'taskCreated', { id });
  return { task: ws.tasks[id], created: !existing, changed: true };
}

/**
 * Detect inline subtask objects in a ticket's subtasks array and normalize them
 * into separate ticket files. Returns the normalized string[] of IDs if changes
 * were made, or null if no normalization needed.
 */
export async function normalizeInlineSubtasks(frontmatter: Record<string, unknown>, parentPath: string): Promise<string[] | null> {
  const subtasks = frontmatter.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) return null;

  const hasInlineObjects = subtasks.some((entry) => typeof entry === 'object' && entry !== null);
  if (!hasInlineObjects) return null;

  const fluxDir = path.dirname(parentPath);
  const parentId = typeof frontmatter.id === 'string' && frontmatter.id ? frontmatter.id : path.basename(parentPath, '.md');
  const normalizedIds: string[] = [];
  const createdAt = new Date().toISOString();

  for (const entry of subtasks) {
    if (typeof entry === 'string') {
      normalizedIds.push(entry);
      continue;
    }

    if (typeof entry !== 'object' || !entry) continue;

    // Determine the child ID: reuse an explicit id, or allocate a fresh
    // sequential one for id-less inline objects (the FLUX-286 case). Allocation
    // re-scans the directory each call, so writing each child before allocating
    // the next keeps IDs non-colliding.
    let childId: string;
    if (typeof entry.id === 'string' && entry.id) {
      childId = entry.id;
    } else {
      const projectKey = parentId.split('-')[0] || 'FLUX';
      childId = await allocateNewTicketId(fluxDir, projectKey);
      console.warn(`[subtasks] Auto-created ${childId} from id-less inline subtask of ${parentId}`);
    }

    const childPath = path.join(fluxDir, `${childId}.md`);

    // Don't overwrite existing ticket files (a freshly-allocated id won't exist yet).
    try {
      await fs.access(childPath);
      // File exists — just use the ID reference
      normalizedIds.push(childId);
      continue;
    } catch {
      // File doesn't exist — create it
    }

    const childFrontmatter = {
      id: childId,
      title: entry.title || childId,
      status: entry.status || 'Todo',
      priority: entry.priority || 'None',
      effort: entry.effort || 'None',
      assignee: entry.assignee || 'unassigned',
      tags: entry.tags || [],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [
        { type: 'activity', user: 'Agent', date: createdAt, comment: `Auto-created from inline subtask of ${parentId}.` },
      ],
    };

    const childBody = entry.body || `Subtask of ${parentId}.\n`;
    const childContent = matter.stringify(childBody, childFrontmatter);

    try {
      await atomicWriteFile(childPath, childContent);
      log.info(`[subtasks] Auto-created ${childId} from inline subtask of ${parentId}`);
    } catch (err) {
      console.error(`[subtasks] Failed to create ${childId}:`, err);
    }

    normalizedIds.push(childId);
  }

  log.info(`[subtasks] Normalized ${parentId}: ${subtasks.length} entries → ${normalizedIds.length} string IDs`);
  return normalizedIds;
}

export async function loadTask(filePath: string, ws: Workspace = getWorkspace()) {
  // FLUX-1132: thin timing wrapper — every exit path (including the early-return guards below)
  // feeds `store.loadTask`, so the histogram reflects the real call rate off the file watcher.
  const __loadTaskStartedAt = performance.now();
  try {
    return await loadTaskInner(filePath, ws);
  } finally {
    // FLUX-1202: the histogram alone can't name the culprit behind a single-call outlier —
    // warn per-file so a future spike is diagnosable directly instead of inferred after the fact.
    const __loadTaskMs = performance.now() - __loadTaskStartedAt;
    recordDuration('store.loadTask', __loadTaskMs);
    warnIfSlowLoadTask(filePath, __loadTaskMs);
  }
}

async function loadTaskInner(filePath: string, ws: Workspace) {
  if (!isTopLevelTaskFile(filePath)) return;
  if (repairingPaths.has(filePath)) return;
  // Skip the watcher event generated by our own write-back (see recentEngineWrites).
  if (recentEngineWrites.delete(filePath)) return;

  try {
    const fileStats = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');

    // Guard: empty/truncated file is a sign of a partial write in progress — skip
    if (!content || !content.trim()) {
      console.warn(`[loadTask] Ignoring empty file: ${filePath}`);
      return;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(content);
    } catch (yamlErr) {
      const msg = yamlErr instanceof Error ? yamlErr.message : String(yamlErr);
      const id = path.basename(filePath, '.md');
      // Common corruption mode: a sync merge committed unresolved git conflict
      // markers into the frontmatter (FLUX-703 / FLUX-694). Surface that explicitly
      // so the fix is obvious instead of a cryptic YAML "block mapping" error.
      const hasConflictMarkers = /^<{7} /m.test(content) && /^>{7} /m.test(content);
      const detail = hasConflictMarkers
        ? `contains unresolved git conflict markers (<<<<<<< / ======= / >>>>>>>) — a sync merge committed an unresolved conflict. Resolve the markers (keep both history entries, chronological order) and save again.`
        : `YAML frontmatter is invalid: ${msg}`;
      console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  ${detail}\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
      delete ws.tasks[id];
      ws.parseErrors[id] = { id, path: filePath, error: detail };
      return;
    }

    // Guard: if we already have this ticket cached with a title but the incoming
    // file lost it (and other critical fields), this is a corrupt/partial write —
    // ignore it rather than repairing it into a "(recovered)" zombie.
    const existingId = parsed.data.id || path.basename(filePath, '.md');
    const existingCached = ws.tasks[existingId];
    if (existingCached && existingCached.title && !parsed.data.title && !parsed.data.status) {
      console.warn(`[loadTask] Ignoring corrupt write for ${existingId}: file lost title+status while cache has "${existingCached.title}". Likely a partial write or unauthorized direct edit.`);
      return;
    }

    // Validate first; only attempt repair if validation fails
    const initialErrors = validateTicketFrontmatter(parsed.data);
    if (initialErrors.length > 0) {
      const repairs = repairTicket(parsed.data, filePath);
      if (repairs.length > 0) {
        log.info(`[FLUX AUTO-REPAIR] ${filePath}\n  ${repairs.join('\n  ')}`);
        if (!Array.isArray(parsed.data.history)) parsed.data.history = [];
        parsed.data.history.push({
          type: 'activity',
          user: 'System',
          date: new Date().toISOString(),
          comment: `Auto-repaired ticket: ${repairs.join('; ')}`,
        });
        repairingPaths.add(filePath);
        try {
          const repairedContent = matter.stringify(parsed.content, parsed.data);
          recentEngineWrites.add(filePath);
          await atomicWriteFile(filePath, repairedContent);
        } finally {
          repairingPaths.delete(filePath);
        }
      }

      // Re-validate after repair
      const postRepairErrors = validateTicketFrontmatter(parsed.data);
      if (postRepairErrors.length > 0) {
        const summary = formatValidationErrors(postRepairErrors);
        console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  Schema validation failed (auto-repair insufficient):\n${summary}\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
        const id = path.basename(filePath, '.md');
        delete ws.tasks[id];
        ws.parseErrors[id] = { id, path: filePath, error: `Schema validation failed (auto-repair attempted but insufficient):\n${summary}` };
        return;
      }
    }

    const id = parsed.data['id'] || path.basename(filePath, '.md');
    const normalizedHistory = normalizeHistoryEntries(parsed.data.history);
    const fallbackCreatedAt = fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();
    const { history } = ensureCreationActivity(
      normalizedHistory.history,
      parsed.data.createdBy || parsed.data.updatedBy || 'Unknown',
      fallbackCreatedAt,
    );
    // Protect engine-owned history entries (agent_session, comments) from being
    // dropped when a spawned agent rewrites the ticket file. The agent only knows
    // about a subset of entry types and may silently discard the rest.
    let historyReinjected = false;
    const existingTask = ws.tasks[id];
    if (existingTask && Array.isArray(existingTask.history)) {
      const fileSessionIds = new Set(
        history.filter((e) => e?.type === 'agent_session').map((e) => e.sessionId)
      );
      const fileCommentIds = new Set(
        history.filter((e) => e?.type === 'comment' && e?.id).map((e) => e.id)
      );
      const missingEntries: HistoryEntryLike[] = [];
      for (const entry of existingTask.history) {
        if (entry?.type === 'agent_session' && !fileSessionIds.has(entry.sessionId)) {
          missingEntries.push(entry);
        } else if (entry?.type === 'comment' && entry?.id && !fileCommentIds.has(entry.id)) {
          missingEntries.push(entry);
        }
      }
      if (missingEntries.length > 0) {
        history.push(...missingEntries);
        history.sort((a, b) => getHistoryTimestamp(a) - getHistoryTimestamp(b));
        historyReinjected = true;
        log.info(`[${id}] Re-injected ${missingEntries.length} history entries dropped by agent`);
      }
    }

    // FLUX-1287: retroactively apply FLUX-1202's progress-log compaction to every terminal
    // agent_session entry on load, not just the one entry an in-flight session update touches
    // (updateAgentSessionLocked). Without this, a ticket whose bloat predates FLUX-1202 stays
    // bloated forever — nothing else ever revisits an already-terminal session. Cheap after the
    // first pass: compactSessionProgress is idempotent and a no-op once an entry is already
    // compacted, so this only does real work once per bloated ticket.
    let historyCompacted = false;
    for (const entry of history) {
      if (entry?.type === 'agent_session' && compactSessionProgress(entry)) historyCompacted = true;
    }

    const normalizedFrontmatter: Record<string, unknown> = { ...parsed.data, history };

    // Normalize inline subtask objects → create separate ticket files and convert to string IDs
    const subtasksNormalized = await normalizeInlineSubtasks(normalizedFrontmatter, filePath);

    if (subtasksNormalized) {
      normalizedFrontmatter.subtasks = subtasksNormalized;
    }

    const validationErrors = validateTicketFrontmatter(normalizedFrontmatter);
    if (validationErrors.length > 0) {
      const summary = formatValidationErrors(validationErrors);
      console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  Schema validation failed:\n${summary}\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
      delete ws.tasks[id];
      ws.parseErrors[id] = { id, path: filePath, error: `Schema validation failed:\n${summary}` };
      return;
    }

    ws.tasks[id] = {
      ...normalizedFrontmatter,
      id,
      body: parsed.content,
      _path: filePath
    };

    // Clear any previous parse error for this ticket
    delete ws.parseErrors[id];

    if (normalizedHistory.changed || subtasksNormalized || historyReinjected || historyCompacted) {
      const normalizedContent = matter.stringify(parsed.content, normalizedFrontmatter);
      recentEngineWrites.add(filePath);
      await atomicWriteFile(filePath, normalizedContent);
    }

    if (normalizedFrontmatter.tags && Array.isArray(normalizedFrontmatter.tags)) {
      await autoRegisterUnknownTags(normalizedFrontmatter.tags as string[]);
    }

    log.info(`Loaded task: ${id}`);
  } catch (error) {
    console.error(`Failed to load ${filePath}:`, error);
  }
}

export async function loadDoc(filePath: string, ws: Workspace = getWorkspace()) {
  if (!isDocFile(filePath)) return;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const docPath = getDocPathFromFile(filePath);

    if (!docPath) return;

    const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : titleFromDocPath(docPath);
    const order = parseDocOrder(parsed.data.order);
    const directory = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
    const slugSource = docPath.split('/').filter(Boolean).pop() || docPath;

    ws.docs[docPath] = {
      path: docPath,
      title,
      body: parsed.content.replace(/\r\n/g, '\n'),
      slug: slugifyDocValue(slugSource),
      directory,
      ...(order !== undefined ? { order } : {}),
      _path: filePath,
    };

    log.info(`Loaded doc: ${docPath}`);
  } catch (error) {
    console.error(`Failed to load doc ${filePath}:`, error);
  }
}

export async function loadDocsDirectory(directoryPath: string, ws: Workspace = getWorkspace()) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await loadDocsDirectory(entryPath, ws);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        await loadDoc(entryPath, ws);
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read docs directory ${directoryPath}:`, error);
    }
  }
}

// ─── Group docs (.flux-group) surfaced read-only under the Product prefix ──────

/** Map a `.flux-group` markdown file to its synthetic `Product/...` doc path. */
function groupDocPathFromFile(storeDir: string, filePath: string, ws: Workspace): string | null {
  const relative = path.relative(storeDir, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || !relative.toLowerCase().endsWith('.md')) return null;
  const withoutExt = relative.slice(0, -3);
  const segments = withoutExt.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return null;
  // FLUX-1565: label resolved from the bound `ws`'s own group fields, not the
  // `activeGroupDocsLabel()` singleton — see `loadGroupDoc`'s doc comment.
  const label = groupDocsLabel(ws.groupContext ?? ws.memberBinding?.parentGroup ?? null);
  return [label, ...segments].join('/');
}

/** Load a single group doc into the cache as a read-only Product entry. */
export async function loadGroupDoc(storeDir: string, filePath: string, ws: Workspace = getWorkspace()) {
  const docPath = groupDocPathFromFile(storeDir, filePath, ws);
  if (!docPath) return;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : titleFromDocPath(docPath);
    const order = parseDocOrder(parsed.data.order);
    const directory = docPath.slice(0, docPath.lastIndexOf('/'));
    const slugSource = docPath.split('/').filter(Boolean).pop() || docPath;

    // FLUX-1565: resolve read-only/viaParent from `ws`'s own group fields (populated per-workspace
    // in `hydrateWorkspace`), not the `getGroupContext()`/`getMemberBinding()` singletons — those
    // reflect whichever workspace activated last, not necessarily the one `ws` this load is for.
    ws.docs[docPath] = {
      path: docPath,
      title,
      body: parsed.content.replace(/\r\n/g, '\n'),
      slug: slugifyDocValue(slugSource),
      directory,
      ...(order !== undefined ? { order } : {}),
      // A group doc is genuinely read-only only when no writer resolves. The
      // parent owns the canonical store and edits inline (FLUX-414); a bound
      // member also edits — its writes route through the parent via
      // `submitGroupEdit` (FLUX-419) — so it is editable, flagged `viaParent`
      // so the UI can explain the routed save.
      readOnly: ws.groupContext == null && ws.memberBinding == null,
      ...(ws.groupContext == null && ws.memberBinding != null ? { viaParent: true } : {}),
      group: true,
      _path: filePath,
    };
  } catch (error) {
    console.error(`Failed to load group doc ${filePath}:`, error);
  }
}

/** Walk the `.flux-group` store and load every markdown file read-only. */
async function loadGroupDocsDirectory(storeDir: string, directoryPath: string, ws: Workspace) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git and dotfiles
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await loadGroupDocsDirectory(storeDir, entryPath, ws);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        await loadGroupDoc(storeDir, entryPath, ws);
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read group docs directory ${directoryPath}:`, error);
    }
  }
}

/**
 * The `.flux-group` store dir to surface read-only `Product/` docs from, or null
 * when neither a direct group (parent) nor a member binding is active. A parent
 * reads its own store; a bound member (Case 1) reads the parent's store in place.
 */
function activeGroupStoreDir(ws: Workspace): string | null {
  return ws.groupContext?.groupStoreDir ?? ws.memberBinding?.parentGroup.groupStoreDir ?? null;
}

/** Load all group docs for the active group. No-op in single-repo mode. */
export async function loadGroupDocs(ws: Workspace = getWorkspace()) {
  const storeDir = activeGroupStoreDir(ws);
  if (!storeDir) return;
  await loadGroupDocsDirectory(storeDir, storeDir, ws);
}

export async function reconcileOrphanedSessions(ws: Workspace = getWorkspace()) {
  const now = new Date().toISOString();
  let recoveredCount = 0;

  for (const task of Object.values(ws.tasks)) {
    const history: HistoryEntryLike[] = Array.isArray(task.history) ? task.history : [];

    // Find all active agent_session entries
    const activeSessions = history.filter(
      (e): e is HistoryEntryLike & { sessionId: string } =>
        e.type === 'agent_session' && e.status === 'active' && typeof e.sessionId === 'string'
    );

    for (const session of activeSessions) {
      // FLUX-1572: an active session whose recorded `enginePid` (the ENGINE process that started
      // it, not the CLI subprocess) is still alive belongs to a live SIBLING engine bound to this
      // same shared `.flux`/`.flux-store` — not a genuine restart orphan. Abandoning it here would
      // falsely mark a still-running session dead out from under the engine that owns it. Entries
      // written before this field existed have no `enginePid` and fall back to the old
      // unconditional-abandon behavior (this engine restarting itself is still the common case).
      if (typeof session.enginePid === 'number' && isPidAlive(session.enginePid)) {
        log.info(`Skipping reconcile of session ${session.sessionId} in task ${task.id} — owning engine pid ${session.enginePid} is still alive (likely a sibling engine on this workspace).`);
        continue;
      }
      // Close the orphaned session
      await updateAgentSession(task.id, session.sessionId, (sessionEntry) => {
        sessionEntry.status = 'cancelled';
        sessionEntry.outcome = 'Session abandoned (engine restarted).';
        sessionEntry.endedAt = now;
      }, ws);
      recoveredCount++;
      log.info(`Recovered orphaned session ${session.sessionId} in task ${task.id}`);
    }

    // Also check for old-style activity-based sessions (legacy compatibility)
    const lastLaunch = [...history].reverse().find(
      (e) => e.type === 'activity' && typeof e.comment === 'string' && /Launched .+ session \(/.test(e.comment)
    );
    if (!lastLaunch) continue;
    const launchIdx = history.lastIndexOf(lastLaunch);
    const hasEnd = history.slice(launchIdx + 1).some(
      (e) => (e.type === 'activity' && typeof e.comment === 'string' &&
        /session ended|session stopped|session failed|session lost/i.test(e.comment)) ||
        (e.type === 'agent_session')
    );
    if (!hasEnd) {
      await updateTaskWithHistory(task.id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry('Claude Code session lost (engine restarted).', 'Agent', now)],
      }, ws);
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    log.info(`Session recovery: closed ${recoveredCount} orphaned session(s)`);
  }
}

interface PricingRow {
  match: RegExp;
  inputPer1M: number;
  outputPer1M: number;
  /** Optional — falls back to `inputPer1M * CACHE_READ_DEFAULT_RATIO` when the doc omits the column. */
  cacheReadPer1M?: number;
  /** Optional — falls back to `inputPer1M * CACHE_WRITE_DEFAULT_RATIO` when the doc omits the column. */
  cacheWritePer1M?: number;
  modelName: string;
}

let MODEL_PRICING: PricingRow[] = [];
const DEFAULT_INPUT_PER_1M = 3;
const DEFAULT_OUTPUT_PER_1M = 15;
// FLUX-1375: Anthropic's published prompt-caching multipliers off the base input rate — a cache
// read is far cheaper than a fresh input token, a cache write (creation) costs more. Used whenever
// model-pricing.md doesn't carry explicit cache_read_per_1m/cache_write_per_1m columns for a model
// (e.g. Gemini/Copilot rows, or a Claude row nobody has updated yet). Approximate, not a promise of
// exact billing — real cache-write pricing varies by TTL tier, not modeled here.
const CACHE_READ_DEFAULT_RATIO = 0.1;
const CACHE_WRITE_DEFAULT_RATIO = 1.25;

/** Exported for direct unit testing (task-store-pricing.test.ts) — pure parse, no module state. */
export function parsePricingDoc(markdown: string): PricingRow[] {
  const rows: PricingRow[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map(s => s.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const [model, inputStr, outputStr, cacheReadStr, cacheWriteStr] = cells;
    if (!model || model.startsWith('-') || model.toLowerCase() === 'model') continue;
    const inputPer1M = parseFloat(inputStr!);
    const outputPer1M = parseFloat(outputStr!);
    if (isNaN(inputPer1M) || isNaN(outputPer1M)) continue;
    const cacheReadParsed = cacheReadStr !== undefined ? parseFloat(cacheReadStr) : NaN;
    const cacheWriteParsed = cacheWriteStr !== undefined ? parseFloat(cacheWriteStr) : NaN;
    const row: PricingRow = {
      match: new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      inputPer1M,
      outputPer1M,
      modelName: model,
    };
    if (!isNaN(cacheReadParsed)) row.cacheReadPer1M = cacheReadParsed;
    if (!isNaN(cacheWriteParsed)) row.cacheWritePer1M = cacheWriteParsed;
    rows.push(row);
  }
  rows.sort((a, b) => b.modelName.length - a.modelName.length);
  return rows;
}

export async function loadPricingDoc() {
  try {
    const docPath = path.join(getDocsDir(), 'event-horizon', 'model-pricing.md');
    const content = await fs.readFile(docPath, 'utf-8');
    const parsed = matter(content);
    const rows = parsePricingDoc(parsed.content);
    if (rows.length > 0) {
      MODEL_PRICING = rows;
      log.info(`Loaded ${rows.length} pricing entries from model-pricing.md`);
    }
  } catch {
    // File not present — keep whatever is already loaded
  }
}

/** Token counts broken out by billing class — cache-read/-creation tokens price far differently
 *  from fresh input tokens, so blending them into one `inputTokens` figure (the pre-FLUX-1375
 *  behavior) overstated cost by pricing everything at the full input rate. */
export interface CostTokenBreakdown {
  freshInputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens: number;
}

export function estimateCostUSD(modelHint: string | undefined, tokens: CostTokenBreakdown): number {
  const pricing = modelHint ? MODEL_PRICING.find((p) => p.match.test(modelHint)) : null;
  const inputRate = pricing ? pricing.inputPer1M : DEFAULT_INPUT_PER_1M;
  const outputRate = pricing ? pricing.outputPer1M : DEFAULT_OUTPUT_PER_1M;
  const cacheReadRate = pricing?.cacheReadPer1M ?? inputRate * CACHE_READ_DEFAULT_RATIO;
  const cacheWriteRate = pricing?.cacheWritePer1M ?? inputRate * CACHE_WRITE_DEFAULT_RATIO;
  return (
    tokens.freshInputTokens * inputRate
    + (tokens.cacheReadTokens ?? 0) * cacheReadRate
    + (tokens.cacheCreationTokens ?? 0) * cacheWriteRate
    + tokens.outputTokens * outputRate
  ) / 1_000_000;
}

async function seedStarterDocs(docsDir: string): Promise<void> {
  const entries = await fs.readdir(docsDir).catch(() => [] as string[]);
  if (entries.length > 0) return;

  const projects: string[] = Array.isArray(getConfig().projects) ? getConfig().projects : [];
  const projectKey = projects[0]
    || path.basename(getWorkspaceRoot() || 'PROJECT').toUpperCase().replace(/[^A-Z0-9_-]/g, '')
    || 'PROJECT';

  const overviewFile = path.join(docsDir, 'project-overview.md');
  await fs.writeFile(overviewFile, buildStarterProjectOverview(projectKey), 'utf-8');

  const ehDocsSrc = path.join(resolveEmbeddedDocsRoot(), '.docs', 'event-horizon');
  const ehDocsDest = path.join(docsDir, 'event-horizon');
  try {
    await fs.access(ehDocsSrc);
    try {
      await fs.access(ehDocsDest);
    } catch {
      await copyDir(ehDocsSrc, ehDocsDest);
    }
  } catch (err) {
    console.warn(`[FLUX] Failed to copy EH guide docs to ${ehDocsDest}:`, err);
  }
}

export async function initDir(ws: Workspace = getWorkspace()) {
  // FLUX-1132: thin timing wrapper around the whole disk rescan — see recordFullRescan.
  const __initDirStartedAt = performance.now();
  try {
    try {
      await fs.mkdir(getActiveFluxDir(), { recursive: true });
      await fs.mkdir(getDocsDir(), { recursive: true });
      await fs.mkdir(getTaskAssetsDir(), { recursive: true });
      await seedStarterDocs(getDocsDir());
      await loadDocsDirectory(getDocsDir(), ws);
      // FLUX-1559: orphan mode protects config.json/read-state.json/boot-index.json via the
      // .flux-store worktree's own .gitignore (excludeLocalConfigFromSync); non-orphan mode's
      // .flux/ has no such path at all, so these per-machine files churn the user's working
      // tree if .flux/ is committed. Self-heals on every activation, same as the orphan path.
      if (!isOrphanMode()) await ensureNonOrphanLocalGitignore(getActiveFluxDir());
    } catch {
      // ignore
    }
    await loadConfig();
    await loadPricingDoc();
    await loadCustomPersonas();
    const activeDir = getActiveFluxDir();
    const fluxFiles = await fs.readdir(activeDir).catch(() => [] as string[]);
    const names = fluxFiles.filter((name) => isTopLevelTaskFile(path.join(activeDir, name)));
    // FLUX-1540: in-memory filter of the already-read `fluxFiles` list — no extra I/O —
    // so the portal's cold-boot loading state can show real "Loaded X / Y" progress
    // instead of a static skeleton for the whole scan.
    const total = names.length;
    let loaded = 0;
    const emitBootProgress = (phase: 'cached' | 'scanning' | 'ready') => {
      // broadcastEvent is best-effort (FLUX-910 — a dead client can't throw out of its fan-out
      // loop), but this is deliberately isolated anyway so a future change to it can never stall
      // or abort the boot scan.
      try {
        broadcastEvent('bootProgress', { loaded, total, phase }, ws);
      } catch (err) {
        console.warn('[FLUX] bootProgress broadcast failed (non-fatal):', err);
      }
    };

    // FLUX-1547 Phase 2: a valid persisted boot index lets an unchanged file skip the entire
    // read+YAML-parse+validate+history-normalize pipeline — only a cheap `stat` is needed to
    // confirm it's still fresh. Missing/corrupt/version-mismatched index → every name below is
    // simply a "miss" and the scan behaves exactly like a fully cold boot.
    const bootIndex = await loadBootIndex(activeDir);
    let needsFullLoad = names;
    if (bootIndex) {
      needsFullLoad = await partitionByBootIndex(
        activeDir,
        names,
        bootIndex,
        (id, data, name) => {
          ws.tasks[id] = { ...data, id, _path: path.join(activeDir, name) };
          loaded += 1;
        },
        BOOT_SCAN_CONCURRENCY,
      );
      // Only announce the 'cached' phase when there's still full-load work left to do — a fully
      // warm boot (every file hit the cache) has nothing more to report and falls straight
      // through to the single unconditional 'ready' emission below.
      if (loaded > 0 && needsFullLoad.length > 0) emitBootProgress('cached');
    }

    // FLUX-1547 Phase 1: bounded-concurrency pool replaces the old strictly-serial
    // `for (const name of fluxFiles) { await loadTask(...) }` loop. The per-file guards this
    // relies on (`repairingPaths`, `recentEngineWrites`, the corrupt-write skip in
    // loadTaskInner) are already keyed per file path, so concurrent loads of *different* files
    // never race each other — only re-entrant loads of the *same* path would, and the scan only
    // ever issues one `loadTask` per path. Final `ws.tasks` state is order-independent: every
    // file's result is written under its own id regardless of completion order. The previous
    // explicit `RESCAN_YIELD_EVERY` + `await new Promise(setImmediate)` yield (FLUX-1188) is no
    // longer needed — with several files in flight at once, the awaits on their own I/O already
    // give the event loop turns at natural intervals instead of one long unbroken serial stretch.
    let loadedSinceEmit = 0;
    await runWithConcurrency(needsFullLoad, BOOT_SCAN_CONCURRENCY, async (name) => {
      await loadTask(path.join(activeDir, name), ws);
      loaded += 1;
      loadedSinceEmit += 1;
      if (loadedSinceEmit >= BOOT_PROGRESS_EVERY) {
        loadedSinceEmit = 0;
        emitBootProgress('scanning');
      }
    });
    emitBootProgress('ready');
    await migrateRequireInputToSwimlane(ws);

    // Refresh the persisted index from the now-fully-populated cache so the *next* boot gets the
    // warm-boot fast path too. Best-effort — persistBootIndex/saveBootIndex never throw.
    await persistBootIndex(activeDir, names, ws.tasks, BOOT_SCAN_CONCURRENCY);
  } finally {
    recordFullRescan(performance.now() - __initDirStartedAt);
  }
}

/**
 * One-time migration: tickets with status "Require Input" get their previous
 * status restored (from the last status_change history entry's `from` field)
 * and swimlane set to 'require-input'. This runs after all tasks are loaded.
 */
async function migrateRequireInputToSwimlane(ws: Workspace) {
  const hasSwimlanes = getConfig().swimlanes && getConfig().swimlanes.length > 0;
  if (!hasSwimlanes) return;

  const requireInputStatus = getConfig().requireInputStatus || 'Require Input';
  const tasksToMigrate = Object.values(ws.tasks).filter(
    (task) => task.status === requireInputStatus && !task.swimlane
  );

  for (const task of tasksToMigrate) {
    const history: HistoryEntryLike[] = Array.isArray(task.history) ? task.history : [];
    const lastStatusChange = [...history].reverse().find(
      (e) => e.type === 'status_change' && e.to === requireInputStatus
    );
    // Fall back to 'Grooming' when no status_change history records where the
    // ticket came from (e.g. tickets created directly in Require Input, or whose
    // history predates status-change tracking) — Grooming is the earliest normal
    // board column, so it's the safest place to drop a ticket whose origin is unknown.
    const previousStatus = lastStatusChange?.from || 'Grooming';

    const migrationEntry = {
      type: 'activity',
      user: 'System',
      date: new Date().toISOString(),
      comment: `Migrated from "${requireInputStatus}" status to swimlane. Previous status "${previousStatus}" restored.`,
    };

    await updateTaskWithHistory(task.id, {
      updatedBy: 'System',
      nextStatus: previousStatus,
      extraFields: { swimlane: 'require-input' },
      entries: [migrationEntry],
    }, ws);
    log.info(`[migration] ${task.id}: status "${requireInputStatus}" → "${previousStatus}" + swimlane:require-input`);
  }

  if (tasksToMigrate.length > 0) {
    log.info(`[migration] Migrated ${tasksToMigrate.length} ticket(s) from "Require Input" status to swimlane.`);
  }
}

// FLUX-343: the three chokidar watcher handles live on the Workspace object now
// (getWorkspace().fluxWatcher / .docsWatcher / .groupDocsWatcher).

// FLUX-1184: shared by the watcher's 'unlink' handler below and reconcileBackgroundPull — a
// ticket's frontmatter `id` can differ from its filename, so prefer the cache entry whose
// `_path` matches before falling back to the basename.
function findTaskIdForPath(filePath: string, ws: Workspace): string {
  const taskEntry = Object.entries(ws.tasks).find(([, task]) => task._path === filePath);
  return taskEntry?.[0] || path.basename(filePath, '.md');
}

// FLUX-1184: attachWorktreeIfPresent's backgrounded orphan-mode `git pull` used to converge via
// startWatchers()'s chokidar watcher replaying an 'add' for every pre-existing file during its
// initial scan — whichever side of the pull-vs-scan race a late-landing write fell on, that
// replay picked it up. The watcher now sets `ignoreInitial: true` (see startWatchers, below) to
// kill a boot-time reload-storm, so it no longer replays anything and can't serve as this catch-up
// path any more. Reload exactly the files the pull touched instead — an incremental reload, not a
// second full scan.
export async function reconcileBackgroundPull(storeDir: string, changedRelativePaths: string[], ws: Workspace = getWorkspace()): Promise<void> {
  for (const rel of changedRelativePaths) {
    const filePath = path.join(storeDir, rel);
    if (!isTopLevelTaskFile(filePath)) continue;
    if (existsSync(filePath)) {
      await loadTask(filePath, ws);
    } else {
      const id = findTaskIdForPath(filePath, ws);
      delete ws.tasks[id];
      log.info(`Removed task: ${id} (background sync pull)`);
    }
  }
}

export async function startWatchers(ws: Workspace = getWorkspace()) {
  if (ws.fluxWatcher) { await ws.fluxWatcher.close(); ws.fluxWatcher = null; }
  if (ws.docsWatcher) { await ws.docsWatcher.close(); ws.docsWatcher = null; }
  if (ws.groupDocsWatcher) { await ws.groupDocsWatcher.close(); ws.groupDocsWatcher = null; }

  const fluxDir = getActiveFluxDir();
  const configFile = path.join(fluxDir, 'config.json');

  ws.fluxWatcher = chokidar.watch(fluxDir, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      if (basename.endsWith('.tmp')) return true;
      // FLUX-855: the HITL store (open-prompts.json) is rewritten on every prompt park/settle and is
      // not a task file — the add/change handlers no-op on it (not *.md, not config.json), so watching
      // it is pure FS-event churn on a hot path. Exclude it (its .tmp sibling is already covered above).
      if (basename === 'open-prompts.json') return true;
      return basename.startsWith('.') && basename !== path.basename(getActiveFluxDir());
    },
    // FLUX-1184: without this, chokidar's own initial directory scan replays an 'add' for every
    // pre-existing top-level ticket file — each one calls loadTask() again — right after initDir()
    // already loaded every one of them directly a moment earlier. On a large board that's a second
    // full reload of the whole store disguised as "watcher activity": it floods the FLUX-1132
    // watcher-storm counter at boot (not real post-boot file churn) and the burst of concurrent
    // loadTask() promises competes with the rest of activateWorkspace()'s setup for the event loop,
    // which is what inflated boot's "slow full rescan"/event-loop-stall telemetry. startWatchers()
    // only ever runs after initDir() (see activateWorkspace()), so the baseline is always already
    // loaded — mirrors startGroupDocsWatcher(), which sets this for the same reason.
    ignoreInitial: true,
    persistent: true,
  });

  ws.fluxWatcher
    .on('add', (filePath) => {
      // FLUX-1132: count reload events the watcher actually triggers (not every fs event chokidar
      // sees — e.g. our own write-back is filtered out inside loadTask, not here).
      if (isTopLevelTaskFile(filePath)) { recordWatchEvent(); void loadTask(filePath, ws); }
      if (filePath === configFile) void loadConfig();
    })
    .on('change', (filePath) => {
      if (isTopLevelTaskFile(filePath)) { recordWatchEvent(); void loadTask(filePath, ws); }
      if (filePath === configFile) void loadConfig();
    })
    .on('ready', () => {
      // FLUX-1556: bind the whole handler to the watcher's OWN workspace (`ws`, already the
      // `startWatchers(ws)` closure param) — chokidar's `ready` fires asynchronously, so without
      // this the handler's `getActiveFluxDir()` calls resolve against whichever board happens to be
      // ambiently active at fire time, not the board whose watcher actually became ready.
      runWithWorkspace(ws, () => {
        void reconcileOrphanedSessions(ws);
        // FLUX-833 (Phase 2): re-surface HITL prompts that were still open when the engine stopped.
        // Runs here (not earlier) so getActiveFluxDir() resolves against the now-activated workspace,
        // alongside the orphaned-session reconcile it conceptually parallels. rehydrate self-guards
        // each record, but wrap the call too (review M1) so nothing it does can throw out of this
        // synchronous chokidar `ready` listener and crash boot.
        try { rehydrateOpenPrompts(); } catch (err) { console.error('[hitl] rehydrate failed', err); }
        // FLUX-1060: restore persisted active-session stubs so the worktree-reclaim guard (and chat
        // resume) see pre-restart running/waiting-input sessions again — otherwise the first reclaim
        // sweep deletes a `waiting-input` session's worktree out from under it. Arm the short post-
        // restart reclaim grace once rehydration has run (covers the sub-sync-interval no-stub gap).
        void rehydrateSessionStubs()
          .then(() => armReclaimGrace())
          .catch((err) => console.error('[session] stub rehydrate failed', err));
      });
    })
    .on('unlink', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        const id = findTaskIdForPath(filePath, ws);
        delete ws.tasks[id];
        log.info(`Removed task: ${id}`);
      }
    })
    // FLUX-784: without this, an unhandled chokidar 'error' (e.g. inotify ENOSPC/EMFILE, or a
    // Windows AV briefly locking a ticket file) rethrows and the uncaughtException handler exits
    // the whole engine. Degrade to "file-sync paused" instead of crashing the board.
    .on('error', (err) => console.error('[watcher:flux] file-sync paused:', err));

  ws.docsWatcher = chokidar.watch(getDocsDir(), {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.docs';
    },
    // FLUX-1184: same reload-storm reasoning as activeFluxWatcher above — initDir() already
    // loaded every doc via loadDocsDirectory() before startWatchers() runs.
    ignoreInitial: true,
    persistent: true,
  });

  const isPricingFile = (filePath: string) => path.basename(filePath) === 'model-pricing.md';

  ws.docsWatcher
    .on('add', (filePath) => { if (isDocFile(filePath)) { void loadDoc(filePath, ws); if (isPricingFile(filePath)) void loadPricingDoc(); } })
    .on('change', (filePath) => { if (isDocFile(filePath)) { void loadDoc(filePath, ws); if (isPricingFile(filePath)) void loadPricingDoc(); } })
    .on('unlink', (filePath) => {
      const docPath = getDocPathFromFile(filePath);
      if (docPath) { delete ws.docs[docPath]; log.info(`Removed doc: ${docPath}`); }
    })
    .on('error', (err) => console.error('[watcher:docs] file-sync paused:', err)); // FLUX-784
}

/**
 * Watch the active group's `.flux-group` store so Product docs refresh after a
 * fan-out / mapping run. No-op in single-repo mode. Called after activateGroup.
 */
export async function startGroupDocsWatcher(ws: Workspace = getWorkspace()) {
  if (ws.groupDocsWatcher) { await ws.groupDocsWatcher.close(); ws.groupDocsWatcher = null; }
  const storeDir = activeGroupStoreDir(ws);
  if (!storeDir) return;

  ws.groupDocsWatcher = chokidar.watch(storeDir, {
    ignored: (filePath: string) => path.basename(filePath) === '.git',
    ignoreInitial: true,
    persistent: true,
  });

  const reload = (filePath: string) => {
    if (filePath.toLowerCase().endsWith('.md')) void loadGroupDoc(storeDir, filePath, ws);
  };
  ws.groupDocsWatcher
    .on('add', reload)
    .on('change', reload)
    .on('unlink', (filePath) => {
      const docPath = groupDocPathFromFile(storeDir, filePath, ws);
      if (docPath) { delete ws.docs[docPath]; log.info(`Removed group doc: ${docPath}`); }
    })
    .on('error', (err) => console.error('[watcher:group-docs] file-sync paused:', err)); // FLUX-784
}


/**
 * FLUX-343: every activation runs through the ActivationLock so two concurrent switch calls
 * (portal workspace picker + storage-mode migration + boot, all of which call this) serialize
 * instead of interleaving cache-clear / watcher teardown / root reassignment. The lock lives on
 * the Workspace object; `isActivating` stays the cheap read-only signal downstream guards check.
 */
export async function activateWorkspace(newRoot: string): Promise<string> {
  // FLUX-1447: resolve the workspace ONCE at the activation entry point and thread that single `ws`
  // through the rest of the activation call graph below — see the migration note at the top of this
  // file for why activation itself still resolves via the bare global rather than the S1 registry.
  const ws = getWorkspace();
  // Epic FLUX-1230: pin the whole activation to `ws` so global-accessor calls inside it
  // (getActiveFluxDir/getConfig/setWorkspaceRoot) resolve to the workspace being (re)activated
  // even when this runs inside some request's workspaceScope binding.
  return ws.activationLock.runExclusive(() => runWithWorkspace(ws, () => doActivateWorkspace(newRoot, ws)));
}

async function doActivateWorkspace(newRoot: string, ws: Workspace): Promise<string> {
  ws.isActivating = true;
  // FLUX-1216 review fix: arm the post-restart reclaim grace synchronously, right here, BEFORE any
  // async work in this function runs (including the pruneTaskWorktrees fire-and-forget call below).
  // Previously this was armed only from the activeFluxWatcher 'ready' handler further down, AFTER
  // rehydrateSessionStubs() resolved — but pruneTaskWorktrees fires (unawaited) well before
  // startWatchers() even runs, so `isWithinReclaimGrace()` read `false` for the entire boot-to-
  // rehydration window, i.e. exactly backwards from the race (a directory that lost its git
  // registration while its session is still mid-rehydration) it exists to protect against. The
  // 'ready' handler's own armReclaimGrace() call still runs too — harmless, it only extends the
  // window — preserving the original post-rehydration buffer pr-cleanup.ts's `worktreeUnreclaimableReason`
  // relies on.
  armReclaimGrace();
  // FLUX-1132/FLUX-1184: thin timing wrapper covering the whole workspace switch (watchers, group
  // docs, sync, ...), which nests initDir()'s own `store.fullRescan` sample. Recorded under the
  // separate `store.workspaceActivation` metric (not `store.fullRescan`) so one boot doesn't log
  // two "slow full rescan" warnings for what is really one disk scan plus setup work around it.
  const __activateWorkspaceStartedAt = performance.now();
  try {
    // Normalize to the canonical long-path form before anything else uses it. On Windows an 8.3
    // short-name path — e.g. a user profile containing a space, "Guy Razer" → GUYRAZ~1 — handed to
    // chokidar makes libuv abort the whole process (fs-event.c `_wcsnicmp` assertion). realpath.native
    // resolves the short name (and symlinks); it's a no-op for already-canonical paths. We REASSIGN
    // `newRoot` so every downstream consumer (watchers, worktrees, group binding) AND the returned
    // value share the one canonical form — callers persist/compare that, so the registry "active"
    // flag can't diverge for a short/symlinked root (FLUX-711). Throws if missing, so guard it.
    try { newRoot = realpathSync.native(newRoot); } catch { /* missing/unresolvable — keep as given */ }
    setWorkspaceRoot(newRoot);
    ws.tasks = {};
    ws.docs = {};
    ws.parseErrors = {};
    clearNotifications();
    log.info(`Workspace: ${newRoot}`);
    await hydrateWorkspace(ws);
    return newRoot; // the canonical bound root — callers persist/respond with THIS (FLUX-711)
  } finally {
    // FLUX-1338: the task set was swapped out wholesale for a different workspace, but this path
    // fires no per-task taskUpdated/Created/Deleted event (and the watchers rescan with
    // ignoreInitial), so `tasksVersion` — which the GET /api/tasks ETag is keyed on — would
    // otherwise stay put across the switch. Bump it so every cached conditional-GET ETag from the
    // previous workspace is invalidated; without this the portal's first post-switch poll gets a
    // 304 and the board keeps rendering the OLD workspace's tickets until an unrelated mutation or
    // a hard reload. The bump MUST sit here at the END of activation, not next to the task-set
    // clear above: the engine keeps serving GET /api/tasks throughout the multi-second activation
    // (requireWorkspace doesn't gate on isActivating), so an early bump would let a mid-activation
    // poll cache a fresh ETag over the EMPTY/partial task set — and since the bulk reload in
    // initDir() broadcasts no per-task events, nothing would ever invalidate it and the board
    // would stick on an empty board. Bumping in `finally` also invalidates ETags handed out
    // mid-activation when activation FAILS after clearing the tasks; a mid-activation 200 over a
    // partial set remains possible but self-heals on the next poll.
    bumpTasksVersion();
    ws.isActivating = false;
    recordWorkspaceActivation(performance.now() - __activateWorkspaceStartedAt);
  }
}

/**
 * FLUX-1529 (epic FLUX-1230 S11): the load/watch/seed body extracted out of `doActivateWorkspace`
 * so a second board can be brought live (`openWorkspaceLive` below) without duplicating this
 * sequence. Deliberately does NOT include the realpath/`setWorkspaceRoot`/cache-clear step or the
 * `finally` version bump — those stay caller-side (activate's clear-in-place vs. live's fresh
 * `Workspace`) — and does NOT reset `ws.tasks`/`ws.docs`/`ws.parseErrors` itself, so calling this
 * twice against an already-hydrated `ws` would layer onto existing state rather than reload from
 * empty; callers own that reset before calling.
 *
 * Reads `root` off `ws.root` rather than taking it as a parameter — both callers already set it
 * before invoking this (`setWorkspaceRoot` in `doActivateWorkspace`, `openWorkspace`/the explicit
 * assignment in `openWorkspaceLive`), and per-request path/config resolution (`getActiveFluxDir`,
 * `getConfig`, etc.) still reads the global active pointer, not `ws.root`, per the FLUX-1529 plan's
 * decision to defer that accessor rewrite.
 */
async function hydrateWorkspace(ws: Workspace): Promise<void> {
  const root = ws.root;
  if (!root) throw new Error('hydrateWorkspace: ws.root must be set before hydration');
  await bootstrapNewWorkspace();
  // FLUX-1184: reload just the files a late-landing background pull touched — see
  // reconcileBackgroundPull's comment for why this replaced relying on the watcher's old
  // initial-scan replay.
  await attachWorktreeIfPresent(root, (storeDir, changedRelativePaths) => {
    void reconcileBackgroundPull(storeDir, changedRelativePaths, ws);
  });
  // Crash recovery: prune git's records of any task worktrees whose dirs were removed out of
  // band before this workspace was last deactivated (FLUX-517) — AND sweep `.eh-worktrees/`
  // for orphaned directories left behind by a failed removal, reaping their lock-holder
  // processes if needed (FLUX-1216; this call now does real, best-effort filesystem deletion
  // and can force-kill OS processes, not just touch git's bookkeeping). Fire-and-forget —
  // runs after activation "completes" from this caller's perspective, so a request landing
  // moments after a workspace switch can race the tail of this sweep on `.eh-worktrees/`.
  pruneTaskWorktrees(root).catch((err) =>
    console.error('[task-worktree] prune on activation failed:', err),
  );
  await migrateStrandedFluxTickets(root);
  await initDir(ws);
  await installSkillsForWorkspace();
  await startWatchers(ws);
  startSyncWatcher();
  // FLUX-1076: a wedged/unmerged .flux-store from before an engine restart otherwise sits
  // silent until some later local file change happens to debounce a sync tick — nothing
  // drives that dry re-check on its own after boot. Kick one immediately (no-ops outside
  // orphan mode) so a pre-existing conflict/error is (re)detected and surfaced right away
  // instead of waiting on incidental activity.
  triggerSync();
  ws.groupContext = await activateGroup(root);
  const memberBinding = await activateMemberBinding(root, (await getWorkspacesList()).map((w) => w.path));
  ws.memberBinding = memberBinding;
  if (memberBinding) {
    // Attach (or refresh) the local group docs worktree for this member workspace
    // so non-EH tools and agents see real files on disk (FLUX-422).
    attachMemberWorktree(root, memberBinding.parentRoot).catch((err) =>
      console.error('[group-worktree] attach failed during workspace activation:', err),
    );
  }
  await loadGroupDocs(ws);
  await startGroupDocsWatcher(ws);
  seedPromptNotifications(ws);
  const modulesToProbe = Array.isArray(getConfig().modules) ? getConfig().modules : [];
  probeAllEnabled(modulesToProbe).catch(() => {});
}

/**
 * FLUX-1529 (epic FLUX-1230 S11): loads a second board live — its own `Workspace` with
 * tasks/docs/watchers running — through the S1 registry (`openWorkspace`), WITHOUT touching
 * whatever `Workspace` is currently active. This is the bootstrap primitive S12 (per-request
 * routing) and S13 (background-load UI) build on; nothing else calls it yet, and it must not be
 * wired into a "load in background" UI before S12 lands (see the caveat below).
 *
 * Canonicalizes `root` the same way `doActivateWorkspace` does (FLUX-711 — the registry key must
 * be canonical), then `openWorkspace`s it, which registers/re-touches the entry and flips the
 * global active pointer to it. Because path/config reads resolve via that pointer, this makes the
 * target board the resolved-active one during (and after) its load — acceptable for now because
 * nothing but tests calls this until S12 wires per-request routing, and it never mutates any
 * *other* `Workspace` object.
 *
 * Idempotent: a `ws` that already has a live `fluxWatcher` is returned as-is, no re-bootstrap.
 */
export async function openWorkspaceLive(root: string): Promise<Workspace> {
  let canonicalRoot = root;
  try { canonicalRoot = realpathSync.native(root); } catch { /* missing/unresolvable — keep as given */ }
  const ws = openWorkspace(canonicalRoot);
  // Epic FLUX-1230: bind the load explicitly to the workspace being brought up. The hydrate body
  // still resolves paths/config via the global accessors (getActiveFluxDir/getConfig — the
  // deferred accessor rewrite, see loadWorkspaceContents' doc), which used to work only because
  // openWorkspace() just moved `activeKey` here. Under per-request resolution (workspaceScope)
  // this call runs inside the REQUESTING board's binding — without this wrap the hydrate would
  // read the OLD board's files into the new Workspace.
  return ws.activationLock.runExclusive(() => runWithWorkspace(ws, async () => {
    if (ws.fluxWatcher) return ws; // already live — idempotent, no reload
    ws.isActivating = true;
    try {
      ws.root = canonicalRoot;
      await hydrateWorkspace(ws);
      return ws;
    } finally {
      ws.isActivating = false;
    }
  }));
}

function seedPromptNotifications(ws: Workspace) {
  const requireInputStatus = getConfig().requireInputStatus || 'Require Input';
  const readyStatus = getConfig().readyForMergeStatus || 'Ready';
  for (const task of Object.values(ws.tasks)) {
    if (task.swimlane === 'require-input') {
      generatePromptNotification(task.id, task.title || task.id, 'Require Input', ws);
    } else if (task.status === requireInputStatus || task.status === readyStatus) {
      generatePromptNotification(task.id, task.title || task.id, task.status, ws);
    }
  }
  // Check if installed agent skills match source version
  checkSkillStaleness('auto').catch(() => {});
}
