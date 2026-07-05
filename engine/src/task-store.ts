import { log } from './log.js';
import { performance } from 'node:perf_hooks';
import { recordDuration } from './perf/registry.js';
import { recordFullRescan, recordWorkspaceActivation } from './perf/rescan-timing.js';
import { recordWatchEvent } from './perf/watch-storm.js';
import { finalMessageNeedsUser } from './final-message-heuristic.js';
import fs from 'fs/promises';
import { renameSync, realpathSync, existsSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import chokidar from 'chokidar';
// FLUX-999 (epic FLUX-996): getMaxIdFromRemote's git fetch used to be a bare execFileAsync — no
// timeout, no non-interactive env — so it could hang EVERY create_ticket in orphan mode forever
// on a slow/unreachable remote or a stalled credential prompt. Route through the S1 runner.
import { runGit } from './git-exec.js';
import { getActiveFluxDir, getTaskAssetsDir, getFluxStoreDir, isOrphanMode, setWorkspaceRoot, workspaceRoot, getWorkspacesList } from './workspace.js';
import { attachWorktreeIfPresent, migrateStrandedFluxTickets } from './storage-sync.js';
import { startSyncWatcher, allocateNewTicketId, triggerSync } from './sync-watcher.js';
import { configCache, loadConfig, autoRegisterUnknownTags } from './config.js';
import { loadCustomPersonas } from './orchestration-personas.js';
import { normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry, findEarliestHistoryDate, getHistoryTimestamp, digestHistoryForAgent, buildHistoryDigest, compactSessionProgress, extractRecentUserComments, extractLaunchFocus, type HistoryEntryLike } from './history.js';
import { generatePromptNotification, generateCompletionNotification, clearNotifications, checkSkillStaleness, addNotification } from './notifications.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { broadcastEvent } from './events.js';
import { rehydrateOpenPrompts } from './hitl-prompts.js';
import { getCliSessionSummaryForTask, getListCliSessionSummaryForTask, getAllSessionSummariesForTask, getListSessionSummariesForTask, slimSessionSummaryForAgent, cliSessionsById, cliSessionIdByTaskId, rehydrateSessionStubs, armReclaimGrace } from './session-store.js';
import { isTopLevelTaskFile, getDocsDir, isDocFile, getDocPathFromFile, titleFromDocPath, slugifyDocValue, parseDocOrder } from './file-utils.js';
import type { StoredDoc } from './file-utils.js';
import { resolveEmbeddedDocsRoot, copyDir, buildStarterProjectOverview } from './docs-seeder.js';
import { bootstrapNewWorkspace, installSkillsForWorkspace } from './bootstrap.js';
import { activateGroup, activateMemberBinding, getGroupContext, getMemberBinding, activeGroupDocsLabel } from './group.js';
import { attachMemberWorktree } from './group-member-worktree.js';
import { pruneTaskWorktrees } from './task-worktree.js';
import { probeAllEnabled } from './module-probe.js';

/**
 * Minimal shape of a cached/validated ticket as accessed by this file's helpers. `tasksCache`
 * itself intentionally stays `Record<string, any>` right below (see that export's comment) —
 * narrowing ITS declared value type cascades into ~40 other files that read/assign
 * `tasksCache[id]` directly (empirically verified while working this ticket: doing so broke
 * agents/{claude-code,copilot,gemini}.ts, furnace-stoker.ts, mcp-server.ts, and several test
 * fixtures that construct partial ticket literals — `noUncheckedIndexedAccess` adds `| undefined`
 * to every `tasksCache[id]` read the instant the value type isn't literally `any`). A function
 * that merely RECEIVES an `any`-typed task value can still declare a real parameter type, though:
 * an `any` argument satisfies any parameter type without a cast. Only fields this file actually
 * reads are named here; every other frontmatter field still round-trips through the index
 * signature untouched.
 */
export interface TaskRecord {
  id: string;
  title: string;
  status: string;
  body: string;
  _path: string;
  priority?: string | null | undefined;
  effort?: string | null | undefined;
  assignee?: string | null | undefined;
  swimlane?: string | null | undefined;
  [key: string]: unknown;
}

/**
 * Frontmatter bag as read fresh from disk (readTaskFromDisk) and mutated in place before being
 * written back (updateAgentSessionLocked / updateTaskWithHistoryLocked). Narrower than TaskRecord
 * because a freshly-read or partially-repaired file may legitimately be missing any field (hence
 * the `!frontmatter.title`-style guards below) — only fields read with a concrete expected type
 * are named; everything else (including fields only ever written, like `needsAction`/
 * `tokenMetadata`) flows through the index signature, since writing a concrete value into an
 * `unknown`-typed slot never needs narrowing.
 */
export interface TaskFrontmatter {
  title?: string | undefined;
  createdBy?: string | undefined;
  swimlane?: string | null | undefined;
  [key: string]: unknown;
}

// FLUX-1073: `tasksCache`'s value type intentionally stays `any` — see the TaskRecord doc comment
// above for why narrowing it is out of scope for a single-file typing pass.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let tasksCache: Record<string, any> = {};
export let docsCache: Record<string, StoredDoc> = {};
export let parseErrors: Record<string, { id: string; path: string; error: string }> = {};
export let workspaceActivating = false;

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
const surfacedFinalMessages = new Set<string>();

/**
 * Write file atomically: write to a .tmp sibling then rename over the target.
 * Prevents partial/empty reads when another async operation reads mid-write.
 * Falls back to direct write if rename fails (e.g., cross-device).
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, content, 'utf-8');
  try {
    renameSync(tmpPath, filePath);
  } catch {
    // rename can fail on some FS setups; fall back to direct write
    await fs.writeFile(filePath, content, 'utf-8');
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export function serializeTaskForApi(task: TaskRecord) {
  const cliSessions = getAllSessionSummariesForTask(task.id);
  return {
    ...task,
    cliSession: getCliSessionSummaryForTask(task.id),
    cliSessions: cliSessions.length > 0 ? cliSessions : undefined,
  };
}

// Default history window for the agent-facing serializer. Agents need the
// recent conversation, not the full archaeology — older entries stay on disk
// and are reported via `olderHistoryEntries`.
const AGENT_HISTORY_LIMIT = 20;

// AXI #3 (content truncation + size hint, FLUX-879) for the ticket `body` in the
// agent view. The body is load-bearing (the plan / acceptance criteria live there),
// so the threshold is GENEROUS — normal tickets are never touched; this targets only
// pathological bodies that would otherwise dominate the get_ticket payload on every
// read (agent-payload-metrics measures `body` as its own section). ~12k chars ≈ 3k tokens.
export const AGENT_BODY_LIMIT = 12_000;

/**
 * Truncate an oversized ticket `body` for the agent view, mirroring the history
 * truncation idiom: keep the head and append a recoverable size hint with an
 * opt-in escape hatch (`get_ticket(..., fullBody:true)`). Returns `{}` when the
 * body should pass through untouched (escape hatch set, not a string, or under the
 * limit) so the caller's `...task` body is left intact; returns the truncated body
 * plus `bodyTruncated`/`bodyOmittedChars` signals only when it actually trims. Pure
 * + exported for unit test (mirrors the `evaluateWorktreeReadyRefusal` idiom).
 */
export function truncateBodyForAgent(
  body: unknown,
  fullBody?: boolean,
): { body?: string; bodyTruncated?: true; bodyOmittedChars?: number } {
  if (fullBody || typeof body !== 'string' || body.length <= AGENT_BODY_LIMIT) return {};
  const omitted = body.length - AGENT_BODY_LIMIT;
  const head = body.slice(0, AGENT_BODY_LIMIT);
  return {
    body: `${head}\n\n…[${omitted} of ${body.length} body chars omitted to save context — pass fullBody:true to get_ticket, or open the ticket, to see all]`,
    bodyTruncated: true,
    bodyOmittedChars: omitted,
  };
}

/**
 * Agent-facing serializer for the MCP `get_ticket` tool. Unlike
 * {@link serializeTaskForApi} it digests `agent_session` history entries to
 * one-line summaries (dropping `progress[]`, which is per-second output noise
 * from prior sessions and the dominant weight on heavily-worked tickets) and
 * windows history to the most recent entries. REST detail stays full-fat for
 * the portal. Use `get_session_log` semantics (fetch by sessionId) for raw
 * progress when an agent genuinely needs it.
 */
export function serializeTaskForAgent(task: TaskRecord, historyLimit?: number, opts: { expand?: string[] | undefined; fullHistory?: boolean | undefined; fullBody?: boolean | undefined } = {}) {
  const keepRecent = configCache?.commentDigest?.keepRecent ?? 3;
  const fullHistory = Array.isArray(task.history) ? task.history : [];
  const { history, olderHistoryEntries, collapsedCount } = digestHistoryForAgent(
    fullHistory,
    historyLimit ?? AGENT_HISTORY_LIMIT,
    keepRecent,
    opts,
  );
  // FLUX-480: always surface the last few user-authored comments (even if they
  // fall outside the history window) and the persisted launch focus, plus cheap
  // boolean/timestamp flags so routing/preview consumers (FLUX-478/483) can read
  // them without pulling full history.
  const keepUserComments = configCache?.commentDigest?.recentUserComments ?? 3;
  const recentUserComments = extractRecentUserComments(fullHistory, keepUserComments);
  const launchFocus = extractLaunchFocus(fullHistory);
  const cliSession = getCliSessionSummaryForTask(task.id);
  const cliSessions = getListSessionSummariesForTask(task.id).map(slimSessionSummaryForAgent);
  return {
    ...task,
    // AXI #3 body truncation (FLUX-879): override the spread `body` only when oversized.
    ...truncateBodyForAgent(task.body, opts.fullBody),
    // FLUX-985: coerce nullable/absent frontmatter. A hand-edited or legacy ticket can carry
    // status/priority/effort/assignee = null or tags = null (an empty YAML line parses to null),
    // and the engine's own validator permits it. The MCP get_ticket outputSchema is strict on
    // these declared fields — and .optional() REJECTS null — so an un-coerced null would make the
    // whole read return "Output validation error" instead of the ticket. Normalize to the same
    // defaults create_ticket uses so agents never see null (FLUX-950 regression).
    status: task.status ?? '',
    priority: task.priority ?? 'None',
    effort: task.effort ?? 'None',
    assignee: task.assignee ?? 'unassigned',
    tags: Array.isArray(task.tags) ? task.tags.filter((x) => typeof x === 'string') : [],
    history,
    ...(olderHistoryEntries > 0 ? { olderHistoryEntries } : {}),
    ...(collapsedCount ? { collapsedCount } : {}),
    ...(recentUserComments.length > 0
      ? {
          recentUserComments,
          hasUserComments: true,
          lastUserCommentAt: recentUserComments[recentUserComments.length - 1]!.date,
        }
      : { hasUserComments: false }),
    ...(launchFocus ? { launchFocus: launchFocus.launchFocus, hasLaunchFocus: true } : {}),
    cliSession: cliSession ? slimSessionSummaryForAgent(cliSession) : undefined,
    cliSessions: cliSessions.length > 0 ? cliSessions : undefined,
  };
}

/**
 * Terminal statuses shared by the MCP `list_tickets` active-by-default screen
 * (FLUX-489) and the REST `GET /api/tasks?active=true` filter (FLUX-970) — one
 * definition so both surfaces agree on what "resting" means.
 */
export function getTerminalStatuses(): string[] {
  return ['Done', 'Released', configCache?.archiveStatus || 'Archived'];
}

/**
 * List-endpoint serializer. Like {@link serializeTaskForApi} but attaches a
 * capped `cliSessions[]` (active sessions + most-recent completed group, with
 * truncated `liveOutput`) so `GET /api/tasks` payload doesn't grow with session
 * history. The detail endpoint keeps {@link serializeTaskForApi}.
 */
export function serializeTaskForList(task: TaskRecord) {
  const cliSessions = getListSessionSummariesForTask(task.id);
  // FLUX-725: replace the raw `history[]` (fetched + parsed on every ~3s poll / `taskUpdated` SSE on
  // a large board) with a compact derived `historyDigest` the cards + attention surfaces read for
  // their aggregates (flow arrows, done-streak, rust, time-in-column, speed-demon, unread, require-
  // input). The bulk — every status_change, activity, and terminal agent_session (the latter carrying
  // long finalMessage/summary/token metadata) — is dropped. We KEEP the entry types the card renders
  // INLINE: `comment` (the hover comment popover shows text + threaded replies) and the ACTIVE
  // agent_session (the card's inline live-progress reads it, keyed by sessionId). The detail endpoint
  // (serializeTaskForApi) still carries full `history` for the modal/chat, which lazy-fetch on open.
  const fullHistory = Array.isArray(task.history) ? task.history : [];
  const { history: _history, ...rest } = task;
  // FLUX-957: collect the inline-rendered entries in the same pass buildHistoryDigest already
  // makes over fullHistory, instead of a second O(n) `.filter`. Comments and active sessions are
  // collected into separate buckets (each tagged with its traversal index) so FLUX-1144 can cap
  // comments to the most recent few below without disturbing the active-session entries or the
  // original relative order once both buckets are merged back together.
  const commentEntries: Array<{ i: number; e: HistoryEntryLike }> = [];
  const sessionEntries: Array<{ i: number; e: HistoryEntryLike }> = [];
  let entryIndex = 0;
  const historyDigest = buildHistoryDigest(fullHistory, task.status, task.swimlane, undefined, (e) => {
    const i = entryIndex++;
    if (e?.type === 'comment') commentEntries.push({ i, e });
    else if (e?.type === 'agent_session' && e?.status === 'active') sessionEntries.push({ i, e });
  });
  // FLUX-1144: comments were ~50% of a full-board list response (4,257 comments / 11MB measured
  // 2026-07-05) — the hover popover only ever needs recent context at a glance ("Open in full
  // view" reads the complete thread off the detail endpoint). Cap the full-text comments shipped
  // here to the most recent `keepRecent`; board-wide unread badges + "mark all read" already read
  // comment ids from `historyDigest.comments` (full, text-free) rather than this array, so capping
  // it only changes which comments render inline on hover, not what counts as read/unread.
  const keepRecentComments = configCache?.commentDigest?.keepRecent ?? 3;
  const keptComments = keepRecentComments > 0 ? commentEntries.slice(-keepRecentComments) : [];
  const inlineHistory = [...keptComments, ...sessionEntries]
    .sort((a, b) => a.i - b.i)
    .map(({ e }) => e);
  return {
    ...rest,
    history: inlineHistory,
    historyDigest,
    // FLUX-1144: truncates `liveOutput` to a short tail — see getListCliSessionSummaryForTask.
    cliSession: getListCliSessionSummaryForTask(task.id),
    cliSessions: cliSessions.length > 0 ? cliSessions : undefined,
  };
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
export function updateAgentSession(taskId: string, sessionId: string, updater: (session: Record<string, unknown>) => void) {
  return serializeTicketWrite(taskId, () => updateAgentSessionLocked(taskId, sessionId, updater));
}

async function updateAgentSessionLocked(taskId: string, sessionId: string, updater: (session: Record<string, unknown>) => void) {
  const task = tasksCache[taskId];
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
      surfacedFinalMessages.add(sessionId);
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
  tasksCache[taskId] = { ...frontmatter, body, id: taskId, _path: task._path };
  return tasksCache[taskId];
}

// Per-ticket write serialization (FLUX-645). With a single shared MCP server, concurrent
// sessions issue concurrent read-modify-write on a ticket's history; without a lock the later
// write reads stale frontmatter and clobbers the earlier append, dropping history entries. A
// per-ticketId promise chain serializes writes to the SAME ticket while writes to DIFFERENT
// tickets stay parallel. (One engine process finally makes this enforceable — the old
// N-stdio-servers design couldn't share a lock.)
const ticketWriteChains = new Map<string, Promise<unknown>>();

function serializeTicketWrite<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  const prev = ticketWriteChains.get(taskId) ?? Promise.resolve();
  // Chain onto the previous write whether it resolved or rejected, so one failed write
  // doesn't wedge the queue for that ticket.
  const result = prev.then(run, run);
  // Keep a non-rejecting tail as the chain head, and prune the map entry once this is the
  // last write in flight so the map doesn't grow unbounded across many tickets.
  const tail = result.then(() => {}, () => {});
  ticketWriteChains.set(taskId, tail);
  void tail.then(() => {
    if (ticketWriteChains.get(taskId) === tail) ticketWriteChains.delete(taskId);
  });
  return result;
}

export function updateTaskWithHistory(taskId: string, options: {
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
  tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated: boolean; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
  // FLUX-987: append this child ticket id to frontmatter.subtasks. Computed from the FRESH
  // on-disk array read under THIS lock acquisition (not a precomputed array passed via
  // extraFields) — a concurrent write to the same parent (add_note/change_status/another
  // create_ticket) can't clobber this addition, which is exactly the race this option closes.
  appendSubtask?: string;
}) {
  return serializeTicketWrite(taskId, () => updateTaskWithHistoryLocked(taskId, options));
}

async function updateTaskWithHistoryLocked(taskId: string, options: {
  entries?: unknown[];
  updatedBy?: string;
  nextStatus?: string;
  extraFields?: Record<string, unknown>;
  deleteFields?: string[];
  newTitle?: string;
  newBody?: string;
  tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated: boolean; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
  appendSubtask?: string;
}) {
  const task = tasksCache[taskId];
  if (!task) return null;

  const actor = options.updatedBy || task.updatedBy || 'Agent';
  const activityTimestamp = new Date().toISOString();
  const entries = Array.isArray(options.entries) ? [...options.entries] : [];
  const { _path } = task;

  const { frontmatter, body } = await readTaskFromDisk(task);

  const normalizedExistingHistory = normalizeHistoryEntries(Array.isArray(frontmatter.history) ? frontmatter.history : []);
  let nextHistory = ensureCreationActivity(
    normalizedExistingHistory.history,
    frontmatter.createdBy || actor,
    findEarliestHistoryDate(normalizedExistingHistory.history),
  ).history;

  if (options.nextStatus && frontmatter.status !== options.nextStatus) {
    entries.push({
      type: 'status_change',
      from: frontmatter.status,
      to: options.nextStatus,
      user: actor,
      date: activityTimestamp,
    });
    frontmatter.status = options.nextStatus;
    // FLUX-651: any real status move is a board action — clear the "agent parked" flag so the
    // ticket stops showing as Needs Action (covers the agent advancing it AND the user moving
    // the card via the board). Skip when extraFields explicitly sets needsAction (the backstop).
    if (!(options.extraFields && 'needsAction' in options.extraFields)) {
      frontmatter.needsAction = null;
    }
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

  const fileContent = matter.stringify(useBody || '', frontmatter);
  recentEngineWrites.add(_path);
  await atomicWriteFile(_path, fileContent);
  tasksCache[taskId] = { ...frontmatter, body: useBody, id: taskId, _path };

  if (options.nextStatus) {
    const requireInputStatus = configCache.requireInputStatus || 'Require Input';
    const readyStatus = configCache.readyForMergeStatus || 'Ready';
    if (options.nextStatus === requireInputStatus || options.nextStatus === readyStatus) {
      generatePromptNotification(taskId, frontmatter.title || taskId, options.nextStatus);
    } else if (options.nextStatus === 'Done') {
      generateCompletionNotification(taskId, frontmatter.title || taskId);
    }
  }

  return tasksCache[taskId];
}

/**
 * Normalize a ticket's `subtasks` frontmatter (string ids or legacy inline `{id}` objects)
 * to a plain string[] of child ids. Shared by the parent/subtask link sync (FLUX-1068).
 */
export function subtaskIds(subtasks: unknown): string[] {
  return (Array.isArray(subtasks) ? subtasks : [])
    .map((s) => (typeof s === 'string' ? s : s?.id))
    .filter(Boolean);
}

/**
 * Guard against self-parenting and cycles before (re)linking a child to a parent (FLUX-1068).
 * Walks the prospective parent's ancestor chain via the cache; if it reaches the child, the link
 * would create a cycle (A→B→A). Returns a human-readable error string, or null when the link is
 * valid. A pre-existing cycle in the data stops the walk rather than looping forever.
 */
export function validateParentLink(childId: string, newParentId: string | null | undefined): string | null {
  if (!newParentId) return null;
  if (newParentId === childId) return `Cannot set ${childId} as its own parent.`;
  const seen = new Set<string>();
  let cursor: string | null | undefined = newParentId;
  while (cursor) {
    if (cursor === childId) {
      return `Cannot set parent ${newParentId} on ${childId}: it would create a cycle (${childId} is already an ancestor of ${newParentId}).`;
    }
    if (seen.has(cursor)) break; // pre-existing cycle in the data — don't loop
    seen.add(cursor);
    cursor = tasksCache[cursor]?.parentId || null;
  }
  return null;
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
}): Promise<void> {
  const { id, oldParentId, newParentId, actor } = opts;
  const oldSubtasks = opts.oldSubtasks ?? [];
  const newSubtasks = opts.newSubtasks ?? [];

  const writeParentSubtasks = async (parentId: string, subtasks: string[]) => {
    const parent = tasksCache[parentId];
    if (!parent) return;
    const parentRaw = await fs.readFile(parent._path, 'utf-8');
    const parentParsed = matter(parentRaw);
    parentParsed.data.subtasks = subtasks;
    parentParsed.data.updatedBy = actor;
    recentEngineWrites.add(parent._path);
    await atomicWriteFile(parent._path, matter.stringify(parentParsed.content, parentParsed.data));
    tasksCache[parentId] = { ...tasksCache[parentId], subtasks, updatedBy: actor };
    broadcastEvent('taskUpdated', { id: parentId });
  };

  const writeChildParent = async (childId: string, parentId: string | null) => {
    const child = tasksCache[childId];
    if (!child) return;
    const childRaw = await fs.readFile(child._path, 'utf-8');
    const childParsed = matter(childRaw);
    if (parentId) childParsed.data.parentId = parentId;
    else delete childParsed.data.parentId;
    childParsed.data.updatedBy = actor;
    recentEngineWrites.add(child._path);
    await atomicWriteFile(child._path, matter.stringify(childParsed.content, childParsed.data));
    tasksCache[childId] = { ...tasksCache[childId], parentId: parentId ?? undefined, updatedBy: actor };
    broadcastEvent('taskUpdated', { id: childId });
  };

  // parentId changed → remove from old parent's subtasks, add to new parent's subtasks.
  if (newParentId !== oldParentId) {
    if (oldParentId && tasksCache[oldParentId]) {
      const cur = subtaskIds(tasksCache[oldParentId].subtasks);
      const filtered = cur.filter((sid) => sid !== id);
      if (filtered.length !== cur.length) await writeParentSubtasks(oldParentId, filtered);
    }
    if (newParentId && tasksCache[newParentId]) {
      const cur = subtaskIds(tasksCache[newParentId].subtasks);
      if (!cur.includes(id)) await writeParentSubtasks(newParentId, [...cur, id]);
    }
  }

  // subtasks array changed → sync each added/removed child's parentId.
  const removedChildren = oldSubtasks.filter((sid) => !newSubtasks.includes(sid));
  const addedChildren = newSubtasks.filter((sid) => !oldSubtasks.includes(sid));

  for (const childId of removedChildren) {
    const child = tasksCache[childId];
    if (child && child.parentId === id) await writeChildParent(childId, null);
  }
  for (const childId of addedChildren) {
    const child = tasksCache[childId];
    if (child && child.parentId !== id) {
      // Remove the child from its previous parent's subtasks before re-linking it here.
      if (child.parentId && tasksCache[child.parentId]) {
        const prev = subtaskIds(tasksCache[child.parentId].subtasks).filter((sid) => sid !== childId);
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
    await runGit(['fetch', 'origin', 'flux-data'], { cwd: storeDir });
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

export async function createTask(options: CreateTaskOptions): Promise<CreateTaskResult> {
  const pKey = options.projectKey || configCache.projects?.[0] || 'FLUX';
  let maxId = 0;
  Object.keys(tasksCache).forEach((key) => {
    if (key.startsWith(`${pKey}-`)) {
      const num = parseInt(key.replace(`${pKey}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });

  if (isOrphanMode()) {
    const remoteMaxId = await getMaxIdFromRemote(pKey);
    maxId = Math.max(maxId, remoteMaxId);
    if (remoteMaxId > 0) {
      log.info(`[tasks] Remote max ID for ${pKey}: ${remoteMaxId}, using ${maxId + 1}`);
    }
  }

  const nextId = `${pKey}-${maxId + 1}`;
  const filePath = path.join(getActiveFluxDir(), `${nextId}.md`);
  const createdAt = new Date().toISOString();
  const actor = options.author || 'Unknown';

  const normalizedHistory = normalizeHistoryEntries([]);
  const historyWithCreation = options.parentId
    ? { history: [{ type: 'activity', user: actor, date: createdAt, comment: `Created as subtask of ${options.parentId}.` }], changed: true }
    : ensureCreationActivity(normalizedHistory.history, actor, createdAt);

  const frontmatter = {
    id: nextId,
    title: options.title || 'New Task',
    status: options.status || 'Todo',
    priority: options.priority || 'None',
    effort: options.effort || 'None',
    assignee: options.assignee || 'unassigned',
    tags: options.tags || [],
    createdBy: actor,
    updatedBy: actor,
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
  tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
  if (!options.skipBroadcast) {
    broadcastEvent('taskCreated', { id: nextId, ...(options.parentId && { parentId: options.parentId }) });
  }

  return { id: nextId, task: tasksCache[nextId] };
}

/**
 * Hard-delete a task: remove its `.md` file from disk and drop it from the cache.
 * Mirrors the inline deletion in the DELETE /api/tasks/:id route, but WITHOUT any
 * worktree/branch teardown — this primitive is for tickets that were never given a
 * branch (e.g. a freshly created card we need to roll back). Best-effort and quiet:
 * a missing file/cache entry is not an error (the caller may be compensating). Used by
 * `extractTicket` (FLUX-738) to remove an orphan card when the curation op fails to persist.
 */
export async function deleteTask(id: string): Promise<void> {
  const task = tasksCache[id];
  delete tasksCache[id];
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
): Promise<{ task: TaskRecord; created: boolean; changed: boolean }> {
  const existing = tasksCache[id];
  const fieldsChanged = !existing || Object.entries(fields).some(([k, v]) => JSON.stringify(existing[k]) !== JSON.stringify(v));
  // A non-empty `body` that differs forces a rewrite (e.g. a gh PR description changed but no
  // field did — FLUX-751). An empty `body` arg never marks changed: it means "keep existing
  // body", so the many callers that omit body don't churn every managed ticket each poll.
  const bodyChanged = body !== '' && body !== (existing?.body ?? '');
  const changed = !existing || fieldsChanged || bodyChanged;
  if (existing && !changed) return { task: existing, created: false, changed: false };

  const filePath = existing?._path || path.join(getActiveFluxDir(), `${id}.md`);
  const now = new Date().toISOString();
  const history = Array.isArray(existing?.history) && existing.history.length > 0
    ? existing.history
    : [{ type: 'activity', user: 'Agent', date: now, comment: 'Created (engine-managed).' }];
  const base = existing ? (() => { const { body: _b, _path: _p, ...fm } = existing; return fm; })() : {};
  const frontmatter = { ...base, ...fields, id, history, updatedBy: 'Agent' };
  const useBody = body || existing?.body || '';

  recentEngineWrites.add(filePath);
  await atomicWriteFile(filePath, matter.stringify(useBody, frontmatter));
  tasksCache[id] = { ...frontmatter, body: useBody, id, _path: filePath };
  broadcastEvent(existing ? 'taskUpdated' : 'taskCreated', { id });
  return { task: tasksCache[id], created: !existing, changed: true };
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

/** Shape of a raw (pre-repair) history entry — every field is unverified, hence all-optional. */
interface RepairableHistoryEntry {
  type?: string;
  from?: string;
  to?: string;
  oldStatus?: string;
  newStatus?: string;
  comment?: string;
  sessionId?: string;
  date?: string;
  user?: string;
  [key: string]: unknown;
}

/**
 * Attempt to repair common schema violations in-place before validation.
 * Returns a list of repairs made, or empty array if nothing was fixed.
 */
export function repairTicket(frontmatter: Record<string, unknown>, filePath: string): string[] {
  const repairs: string[] = [];

  // Missing/invalid status → default to a safe fallback so a repaired ticket never lands in
  // the cache with status: undefined, which crashes the portal's column lookup (FLUX-1076: a
  // conflicted flux-data merge left tickets with corrupt frontmatter that repaired a title but
  // not a status). "Todo" mirrors the default createTask/normalizeInlineSubtasks already use
  // for brand-new tickets, so a recovered ticket lands wherever new work normally starts.
  if (typeof frontmatter.status !== 'string' || !frontmatter.status.trim()) {
    frontmatter.status = 'Todo';
    repairs.push('Recovered missing/invalid status → "Todo"');
  }

  // Missing title → derive from filename
  if (!frontmatter.title || (typeof frontmatter.title === 'string' && !frontmatter.title.trim())) {
    const derived = path.basename(filePath, '.md');
    frontmatter.title = `${derived} (recovered)`;
    repairs.push(`Recovered missing title from filename → "${frontmatter.title}"`);
  }

  // Repair history entries
  if (Array.isArray(frontmatter.history)) {
    for (let i = 0; i < frontmatter.history.length; i++) {
      const entry = frontmatter.history[i] as RepairableHistoryEntry | null | undefined;
      if (!entry || typeof entry !== 'object') continue;

      // oldStatus/newStatus → from/to
      if (entry.type === 'status_change') {
        if (entry.from == null && typeof entry.oldStatus === 'string') {
          entry.from = entry.oldStatus;
          delete entry.oldStatus;
          repairs.push(`history[${i}]: renamed oldStatus → from`);
        }
        if (entry.to == null && typeof entry.newStatus === 'string') {
          entry.to = entry.newStatus;
          delete entry.newStatus;
          repairs.push(`history[${i}]: renamed newStatus → to`);
        }
      }

      // Infer missing type from entry shape
      if (!entry.type || typeof entry.type !== 'string') {
        if (typeof entry.from === 'string' && typeof entry.to === 'string') {
          entry.type = 'status_change';
          repairs.push(`history[${i}]: inferred type "status_change" from from/to fields`);
        } else if (typeof entry.oldStatus === 'string' && typeof entry.newStatus === 'string') {
          entry.type = 'status_change';
          entry.from = entry.oldStatus;
          entry.to = entry.newStatus;
          delete entry.oldStatus;
          delete entry.newStatus;
          repairs.push(`history[${i}]: inferred type "status_change", renamed oldStatus/newStatus → from/to`);
        } else if (typeof entry.comment === 'string' && entry.comment.trim()) {
          entry.type = 'comment';
          repairs.push(`history[${i}]: inferred type "comment" from comment field`);
        } else if (typeof entry.sessionId === 'string') {
          entry.type = 'agent_session';
          repairs.push(`history[${i}]: inferred type "agent_session" from sessionId field`);
        }
      }

      // Fix malformed dates
      if (entry.date && typeof entry.date === 'string') {
        const parsed = new Date(entry.date);
        if (Number.isNaN(parsed.getTime())) {
          const relaxed = new Date(entry.date.replace(/[^\d\-T:.Z+]/g, ''));
          const relaxedYear = relaxed.getFullYear();
          if (!Number.isNaN(relaxed.getTime()) && relaxedYear >= 2020 && relaxedYear <= 2030) {
            entry.date = relaxed.toISOString();
            repairs.push(`history[${i}]: repaired malformed date`);
          } else {
            entry.date = new Date().toISOString();
            repairs.push(`history[${i}]: replaced unparseable date with current timestamp`);
          }
        }
      } else if (!entry.date) {
        entry.date = new Date().toISOString();
        repairs.push(`history[${i}]: added missing date`);
      }

      // Ensure user field
      if (!entry.user || typeof entry.user !== 'string') {
        entry.user = 'Unknown';
        repairs.push(`history[${i}]: set missing user to "Unknown"`);
      }
    }
  }

  // subtasks containing inline objects with id → extract to string array
  if (Array.isArray(frontmatter.subtasks)) {
    let subtasksRepaired = false;
    frontmatter.subtasks = frontmatter.subtasks
      .map((entry: unknown): string | null => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
          subtasksRepaired = true;
          return (entry as { id: string }).id;
        }
        if (entry && typeof entry === 'object') {
          // id-less inline object — normalizeInlineSubtasks should have handled
          // this on load; warn rather than silently discarding (FLUX-286).
          console.warn(`[repairTicket] Discarding id-less inline subtask object in ${path.basename(filePath, '.md')} — expected normalization on load`);
        }
        return null;
      })
      .filter((entry): entry is string => entry != null);
    if (subtasksRepaired) {
      repairs.push('Normalized inline subtask objects to string IDs');
    }
  }

  return repairs;
}

export async function loadTask(filePath: string) {
  // FLUX-1132: thin timing wrapper — every exit path (including the early-return guards below)
  // feeds `store.loadTask`, so the histogram reflects the real call rate off the file watcher.
  const __loadTaskStartedAt = performance.now();
  try {
    return await loadTaskInner(filePath);
  } finally {
    recordDuration('store.loadTask', performance.now() - __loadTaskStartedAt);
  }
}

async function loadTaskInner(filePath: string) {
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
      delete tasksCache[id];
      parseErrors[id] = { id, path: filePath, error: detail };
      return;
    }

    // Guard: if we already have this ticket cached with a title but the incoming
    // file lost it (and other critical fields), this is a corrupt/partial write —
    // ignore it rather than repairing it into a "(recovered)" zombie.
    const existingId = parsed.data.id || path.basename(filePath, '.md');
    const existingCached = tasksCache[existingId];
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
        delete tasksCache[id];
        parseErrors[id] = { id, path: filePath, error: `Schema validation failed (auto-repair attempted but insufficient):\n${summary}` };
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
    const existingTask = tasksCache[id];
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
      delete tasksCache[id];
      parseErrors[id] = { id, path: filePath, error: `Schema validation failed:\n${summary}` };
      return;
    }

    tasksCache[id] = {
      ...normalizedFrontmatter,
      id,
      body: parsed.content,
      _path: filePath
    };

    // Clear any previous parse error for this ticket
    delete parseErrors[id];

    if (normalizedHistory.changed || subtasksNormalized || historyReinjected) {
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

export async function loadDoc(filePath: string) {
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

    docsCache[docPath] = {
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

export async function loadDocsDirectory(directoryPath: string) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await loadDocsDirectory(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        await loadDoc(entryPath);
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
function groupDocPathFromFile(storeDir: string, filePath: string): string | null {
  const relative = path.relative(storeDir, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || !relative.toLowerCase().endsWith('.md')) return null;
  const withoutExt = relative.slice(0, -3);
  const segments = withoutExt.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return null;
  return [activeGroupDocsLabel(), ...segments].join('/');
}

/** Load a single group doc into the cache as a read-only Product entry. */
export async function loadGroupDoc(storeDir: string, filePath: string) {
  const docPath = groupDocPathFromFile(storeDir, filePath);
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

    docsCache[docPath] = {
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
      readOnly: getGroupContext() == null && getMemberBinding() == null,
      ...(getGroupContext() == null && getMemberBinding() != null ? { viaParent: true } : {}),
      group: true,
      _path: filePath,
    };
  } catch (error) {
    console.error(`Failed to load group doc ${filePath}:`, error);
  }
}

/** Walk the `.flux-group` store and load every markdown file read-only. */
async function loadGroupDocsDirectory(storeDir: string, directoryPath: string) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git and dotfiles
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await loadGroupDocsDirectory(storeDir, entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        await loadGroupDoc(storeDir, entryPath);
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
function activeGroupStoreDir(): string | null {
  return getGroupContext()?.groupStoreDir ?? getMemberBinding()?.parentGroup.groupStoreDir ?? null;
}

/** Load all group docs for the active group. No-op in single-repo mode. */
export async function loadGroupDocs() {
  const storeDir = activeGroupStoreDir();
  if (!storeDir) return;
  await loadGroupDocsDirectory(storeDir, storeDir);
}

export async function reconcileOrphanedSessions() {
  const now = new Date().toISOString();
  let recoveredCount = 0;

  for (const task of Object.values(tasksCache)) {
    const history: HistoryEntryLike[] = Array.isArray(task.history) ? task.history : [];

    // Find all active agent_session entries
    const activeSessions = history.filter(
      (e): e is HistoryEntryLike & { sessionId: string } =>
        e.type === 'agent_session' && e.status === 'active' && typeof e.sessionId === 'string'
    );

    for (const session of activeSessions) {
      // Close the orphaned session
      await updateAgentSession(task.id, session.sessionId, (sessionEntry) => {
        sessionEntry.status = 'cancelled';
        sessionEntry.outcome = 'Session abandoned (engine restarted).';
        sessionEntry.endedAt = now;
      });
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
      });
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    log.info(`Session recovery: closed ${recoveredCount} orphaned session(s)`);
  }
}

let MODEL_PRICING: Array<{ match: RegExp; inputPer1M: number; outputPer1M: number; modelName: string }> = [];
const DEFAULT_INPUT_PER_1M = 3;
const DEFAULT_OUTPUT_PER_1M = 15;

function parsePricingDoc(markdown: string) {
  const rows: Array<{ match: RegExp; inputPer1M: number; outputPer1M: number; modelName: string }> = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map(s => s.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const [model, inputStr, outputStr] = cells;
    if (!model || model.startsWith('-') || model.toLowerCase() === 'model') continue;
    const inputPer1M = parseFloat(inputStr!);
    const outputPer1M = parseFloat(outputStr!);
    if (isNaN(inputPer1M) || isNaN(outputPer1M)) continue;
    rows.push({ match: new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), inputPer1M, outputPer1M, modelName: model });
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

export function estimateCostUSD(modelHint: string | undefined, inputTokens: number, outputTokens: number): number {
  const pricing = modelHint ? MODEL_PRICING.find((p) => p.match.test(modelHint)) : null;
  const inputRate = pricing ? pricing.inputPer1M : DEFAULT_INPUT_PER_1M;
  const outputRate = pricing ? pricing.outputPer1M : DEFAULT_OUTPUT_PER_1M;
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

async function seedStarterDocs(docsDir: string): Promise<void> {
  const entries = await fs.readdir(docsDir).catch(() => [] as string[]);
  if (entries.length > 0) return;

  const projects: string[] = Array.isArray(configCache.projects) ? configCache.projects : [];
  const projectKey = projects[0]
    || path.basename(workspaceRoot || 'PROJECT').toUpperCase().replace(/[^A-Z0-9_-]/g, '')
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

export async function initDir() {
  // FLUX-1132: thin timing wrapper around the whole disk rescan — see recordFullRescan.
  const __initDirStartedAt = performance.now();
  try {
    try {
      await fs.mkdir(getActiveFluxDir(), { recursive: true });
      await fs.mkdir(getDocsDir(), { recursive: true });
      await fs.mkdir(getTaskAssetsDir(), { recursive: true });
      await seedStarterDocs(getDocsDir());
      await loadDocsDirectory(getDocsDir());
    } catch {
      // ignore
    }
    await loadConfig();
    await loadPricingDoc();
    await loadCustomPersonas();
    const activeDir = getActiveFluxDir();
    const fluxFiles = await fs.readdir(activeDir).catch(() => [] as string[]);
    // FLUX-1188: loadTask does real synchronous work (YAML parse, validation, repair)
    // between its awaits, so a large board can hold the event loop for whole seconds
    // straight through. Yield every RESCAN_YIELD_EVERY files so concurrent requests
    // (and the perf sampler) get a turn instead of queuing behind the entire rescan.
    const RESCAN_YIELD_EVERY = 50;
    let loadedSinceYield = 0;
    for (const name of fluxFiles) {
      if (isTopLevelTaskFile(path.join(activeDir, name))) {
        await loadTask(path.join(activeDir, name));
        loadedSinceYield += 1;
        if (loadedSinceYield >= RESCAN_YIELD_EVERY) {
          loadedSinceYield = 0;
          await new Promise(setImmediate);
        }
      }
    }
    await migrateRequireInputToSwimlane();
  } finally {
    recordFullRescan(performance.now() - __initDirStartedAt);
  }
}

/**
 * One-time migration: tickets with status "Require Input" get their previous
 * status restored (from the last status_change history entry's `from` field)
 * and swimlane set to 'require-input'. This runs after all tasks are loaded.
 */
async function migrateRequireInputToSwimlane() {
  const hasSwimlanes = configCache.swimlanes && configCache.swimlanes.length > 0;
  if (!hasSwimlanes) return;

  const requireInputStatus = configCache.requireInputStatus || 'Require Input';
  const tasksToMigrate = Object.values(tasksCache).filter(
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
    });
    log.info(`[migration] ${task.id}: status "${requireInputStatus}" → "${previousStatus}" + swimlane:require-input`);
  }

  if (tasksToMigrate.length > 0) {
    log.info(`[migration] Migrated ${tasksToMigrate.length} ticket(s) from "Require Input" status to swimlane.`);
  }
}

let activeFluxWatcher: ReturnType<typeof chokidar.watch> | null = null;
let activeDocsWatcher: ReturnType<typeof chokidar.watch> | null = null;
let activeGroupDocsWatcher: ReturnType<typeof chokidar.watch> | null = null;

// FLUX-1184: shared by the watcher's 'unlink' handler below and reconcileBackgroundPull — a
// ticket's frontmatter `id` can differ from its filename, so prefer the cache entry whose
// `_path` matches before falling back to the basename.
function findTaskIdForPath(filePath: string): string {
  const taskEntry = Object.entries(tasksCache).find(([, task]) => task._path === filePath);
  return taskEntry?.[0] || path.basename(filePath, '.md');
}

// FLUX-1184: attachWorktreeIfPresent's backgrounded orphan-mode `git pull` used to converge via
// startWatchers()'s chokidar watcher replaying an 'add' for every pre-existing file during its
// initial scan — whichever side of the pull-vs-scan race a late-landing write fell on, that
// replay picked it up. The watcher now sets `ignoreInitial: true` (see startWatchers, below) to
// kill a boot-time reload-storm, so it no longer replays anything and can't serve as this catch-up
// path any more. Reload exactly the files the pull touched instead — an incremental reload, not a
// second full scan.
export async function reconcileBackgroundPull(storeDir: string, changedRelativePaths: string[]): Promise<void> {
  for (const rel of changedRelativePaths) {
    const filePath = path.join(storeDir, rel);
    if (!isTopLevelTaskFile(filePath)) continue;
    if (existsSync(filePath)) {
      await loadTask(filePath);
    } else {
      const id = findTaskIdForPath(filePath);
      delete tasksCache[id];
      log.info(`Removed task: ${id} (background sync pull)`);
    }
  }
}

export async function startWatchers() {
  if (activeFluxWatcher) { await activeFluxWatcher.close(); activeFluxWatcher = null; }
  if (activeDocsWatcher) { await activeDocsWatcher.close(); activeDocsWatcher = null; }
  if (activeGroupDocsWatcher) { await activeGroupDocsWatcher.close(); activeGroupDocsWatcher = null; }

  const fluxDir = getActiveFluxDir();
  const configFile = path.join(fluxDir, 'config.json');

  activeFluxWatcher = chokidar.watch(fluxDir, {
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

  activeFluxWatcher
    .on('add', (filePath) => {
      // FLUX-1132: count reload events the watcher actually triggers (not every fs event chokidar
      // sees — e.g. our own write-back is filtered out inside loadTask, not here).
      if (isTopLevelTaskFile(filePath)) { recordWatchEvent(); void loadTask(filePath); }
      if (filePath === configFile) void loadConfig();
    })
    .on('change', (filePath) => {
      if (isTopLevelTaskFile(filePath)) { recordWatchEvent(); void loadTask(filePath); }
      if (filePath === configFile) void loadConfig();
    })
    .on('ready', () => {
      void reconcileOrphanedSessions();
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
    })
    .on('unlink', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        const id = findTaskIdForPath(filePath);
        delete tasksCache[id];
        log.info(`Removed task: ${id}`);
      }
    })
    // FLUX-784: without this, an unhandled chokidar 'error' (e.g. inotify ENOSPC/EMFILE, or a
    // Windows AV briefly locking a ticket file) rethrows and the uncaughtException handler exits
    // the whole engine. Degrade to "file-sync paused" instead of crashing the board.
    .on('error', (err) => console.error('[watcher:flux] file-sync paused:', err));

  activeDocsWatcher = chokidar.watch(getDocsDir(), {
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

  activeDocsWatcher
    .on('add', (filePath) => { if (isDocFile(filePath)) { void loadDoc(filePath); if (isPricingFile(filePath)) void loadPricingDoc(); } })
    .on('change', (filePath) => { if (isDocFile(filePath)) { void loadDoc(filePath); if (isPricingFile(filePath)) void loadPricingDoc(); } })
    .on('unlink', (filePath) => {
      const docPath = getDocPathFromFile(filePath);
      if (docPath) { delete docsCache[docPath]; log.info(`Removed doc: ${docPath}`); }
    })
    .on('error', (err) => console.error('[watcher:docs] file-sync paused:', err)); // FLUX-784
}

/**
 * Watch the active group's `.flux-group` store so Product docs refresh after a
 * fan-out / mapping run. No-op in single-repo mode. Called after activateGroup.
 */
export async function startGroupDocsWatcher() {
  if (activeGroupDocsWatcher) { await activeGroupDocsWatcher.close(); activeGroupDocsWatcher = null; }
  const storeDir = activeGroupStoreDir();
  if (!storeDir) return;

  activeGroupDocsWatcher = chokidar.watch(storeDir, {
    ignored: (filePath: string) => path.basename(filePath) === '.git',
    ignoreInitial: true,
    persistent: true,
  });

  const reload = (filePath: string) => {
    if (filePath.toLowerCase().endsWith('.md')) void loadGroupDoc(storeDir, filePath);
  };
  activeGroupDocsWatcher
    .on('add', reload)
    .on('change', reload)
    .on('unlink', (filePath) => {
      const docPath = groupDocPathFromFile(storeDir, filePath);
      if (docPath) { delete docsCache[docPath]; log.info(`Removed group doc: ${docPath}`); }
    })
    .on('error', (err) => console.error('[watcher:group-docs] file-sync paused:', err)); // FLUX-784
}


export async function activateWorkspace(newRoot: string): Promise<string> {
  workspaceActivating = true;
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
    tasksCache = {};
    docsCache = {};
    parseErrors = {};
    clearNotifications();
    log.info(`Workspace: ${newRoot}`);
    await bootstrapNewWorkspace();
    // FLUX-1184: reload just the files a late-landing background pull touched — see
    // reconcileBackgroundPull's comment for why this replaced relying on the watcher's old
    // initial-scan replay.
    await attachWorktreeIfPresent(newRoot, (storeDir, changedRelativePaths) => {
      void reconcileBackgroundPull(storeDir, changedRelativePaths);
    });
    // Crash recovery: prune git's records of any task worktrees whose dirs were
    // removed out of band before this workspace was last deactivated (FLUX-517).
    // Best-effort — no-op when the repo has no task worktrees.
    pruneTaskWorktrees(newRoot).catch((err) =>
      console.error('[task-worktree] prune on activation failed:', err),
    );
    await migrateStrandedFluxTickets(newRoot);
    await initDir();
    await installSkillsForWorkspace();
    await startWatchers();
    startSyncWatcher();
    // FLUX-1076: a wedged/unmerged .flux-store from before an engine restart otherwise sits
    // silent until some later local file change happens to debounce a sync tick — nothing
    // drives that dry re-check on its own after boot. Kick one immediately (no-ops outside
    // orphan mode) so a pre-existing conflict/error is (re)detected and surfaced right away
    // instead of waiting on incidental activity.
    triggerSync();
    await activateGroup(newRoot);
    const memberBinding = await activateMemberBinding(newRoot, (await getWorkspacesList()).map((w) => w.path));
    if (memberBinding) {
      // Attach (or refresh) the local group docs worktree for this member workspace
      // so non-EH tools and agents see real files on disk (FLUX-422).
      attachMemberWorktree(newRoot, memberBinding.parentRoot).catch((err) =>
        console.error('[group-worktree] attach failed during workspace activation:', err),
      );
    }
    await loadGroupDocs();
    await startGroupDocsWatcher();
    seedPromptNotifications();
    const modulesToProbe = Array.isArray(configCache.modules) ? configCache.modules : [];
    probeAllEnabled(modulesToProbe).catch(() => {});
    return newRoot; // the canonical bound root — callers persist/respond with THIS (FLUX-711)
  } finally {
    workspaceActivating = false;
    recordWorkspaceActivation(performance.now() - __activateWorkspaceStartedAt);
  }
}

function seedPromptNotifications() {
  const requireInputStatus = configCache.requireInputStatus || 'Require Input';
  const readyStatus = configCache.readyForMergeStatus || 'Ready';
  for (const task of Object.values(tasksCache)) {
    if (task.swimlane === 'require-input') {
      generatePromptNotification(task.id, task.title || task.id, 'Require Input');
    } else if (task.status === requireInputStatus || task.status === readyStatus) {
      generatePromptNotification(task.id, task.title || task.id, task.status);
    }
  }
  // Check if installed agent skills match source version
  checkSkillStaleness('auto').catch(() => {});
}
