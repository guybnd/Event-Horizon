import fs from 'fs/promises';
import { renameSync } from 'fs';
import path from 'path';
import { getConfig } from './config.js';
import { getWorkspace } from './workspace-context.js';
import { digestHistoryForAgent, buildHistoryDigest, extractRecentUserComments, extractLaunchFocus, type HistoryEntryLike } from './history.js';
import { getCliSessionSummaryForTask, getListCliSessionSummaryForTask, getAllSessionSummariesForTask, getListSessionSummariesForTask, slimSessionSummaryForAgent } from './session-store.js';

// FLUX-343 (plan step 1): the stateless ticket surface, split out of task-store.ts so the
// serializers/validators/repair path no longer live in the same module as the stateful
// load/write/watch machinery. Nothing here owns state — reads go through getWorkspace()/
// getConfig(). task-store.ts re-exports everything below, so existing importers are unchanged.

/**
 * Minimal shape of a cached/validated ticket as accessed by this file's helpers. The tasks cache
 * itself (`Workspace.tasks`, workspace-context.ts) intentionally stays `Record<string, any>` —
 * narrowing ITS declared value type cascades into ~40 other files that read/assign
 * entries directly (empirically verified while working FLUX-1073: doing so broke
 * agents/{claude-code,copilot,gemini}.ts, furnace-stoker.ts, mcp-server.ts, and several test
 * fixtures that construct partial ticket literals — `noUncheckedIndexedAccess` adds `| undefined`
 * to every indexed read the instant the value type isn't literally `any`). A function
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
  const keepRecent = getConfig()?.commentDigest?.keepRecent ?? 3;
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
  const keepUserComments = getConfig()?.commentDigest?.recentUserComments ?? 3;
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
  return ['Done', 'Released', getConfig()?.archiveStatus || 'Archived'];
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
  }, task.planReviewState as string | null | undefined);
  // FLUX-1144: comments were ~50% of a full-board list response (4,257 comments / 11MB measured
  // 2026-07-05) — the hover popover only ever needs recent context at a glance ("Open in full
  // view" reads the complete thread off the detail endpoint). Cap the full-text comments shipped
  // here to the most recent `keepRecent`; board-wide unread badges + "mark all read" already read
  // comment ids from `historyDigest.comments` (full, text-free) rather than this array, so capping
  // it only changes which comments render inline on hover, not what counts as read/unread.
  const keepRecentComments = getConfig()?.commentDigest?.keepRecent ?? 3;
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
    cursor = getWorkspace().tasks[cursor]?.parentId || null;
  }
  return null;
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
