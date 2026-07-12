import { MODEL_FAMILIES } from './agents/types.js';

export function buildCommentEntry(user: string, comment: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'comment',
    user,
    date,
    comment,
    ...extra,
  };
}

export function buildActivityEntry(comment: string, user: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'activity',
    user: user || 'Unknown',
    date,
    comment,
    ...extra,
  };
}

export function buildAgentMessageEntry(comment: string, user: string, date: string) {
  return {
    type: 'agent_message',
    user: user || 'Unknown',
    date,
    comment,
  };
}

export interface AgentSessionProgress {
  timestamp: string;
  message: string;
  type?: 'text' | 'topic' | 'tool' | 'info';
  data?: unknown;
}

export interface AgentSessionEntry {
  type: 'agent_session';
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  outcome?: string;
  progress: AgentSessionProgress[];
  /** The agent's final text output, set at compaction when the session ends. */
  finalMessage?: string;
  /** Progress length before compaction — present only on compacted entries. */
  originalProgressCount?: number;
  user: string;
  date: string;
  /** Orchestration run this session belonged to (shared across the group). */
  groupId?: string;
  /** Role within the run (e.g. "reviewer:architect", "orchestrator"). */
  role?: string;
  /** Execution pattern of the run (relay | scatter-gather | supervisor). */
  pattern?: string;
}

export function buildAgentSessionEntry(
  sessionId: string,
  startedAt: string,
  label: string,
  group?: { groupId?: string | undefined; role?: string | undefined; pattern?: string | undefined },
): AgentSessionEntry {
  return {
    type: 'agent_session',
    sessionId,
    startedAt,
    status: 'active',
    progress: [],
    user: label,
    date: startedAt,
    ...(group?.groupId ? { groupId: group.groupId } : {}),
    ...(group?.role ? { role: group.role } : {}),
    ...(group?.pattern ? { pattern: group.pattern } : {}),
  };
}

export function appendSessionProgress(
  session: AgentSessionEntry,
  message: string,
  timestamp: string,
): void {
  session.progress.push({ timestamp, message });
}

// ── Loose history-entry shape (lint burndown, FLUX-1073) ────────────────────
// Ticket history entries have no canonical compile-time type — they're validated at RUNTIME by
// schema.ts (validateHistoryEntry) and persisted as loosely-shaped YAML/JSON records (comment,
// activity, status_change, agent_session, swimlane_change, …), each with a different subset of
// fields. routes/tasks.ts's own lint burndown pass named this same shape locally (its `HistoryEntry`
// interface) for the same reason — no shared type existed to import. This names every field these
// helpers read or write; anything else still flows through via the index signature.
export interface HistoryEntryLike {
  type?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  oldStatus?: string | undefined;
  newStatus?: string | undefined;
  comment?: string | undefined;
  user?: unknown;
  date?: string | undefined;
  id?: string | undefined;
  pin?: boolean | undefined;
  summary?: string | undefined;
  supersedes?: unknown;
  supersededBy?: string | undefined;
  supersededByAdvisory?: string | undefined;
  replyTo?: unknown;
  sessionId?: string | undefined;
  status?: string | undefined;
  outcome?: string | undefined;
  progress?: AgentSessionProgress[] | undefined;
  progressCount?: number | undefined;
  originalProgressCount?: number | undefined;
  finalMessage?: string | undefined;
  collapsed?: boolean | undefined;
  launchFocus?: string | undefined;
  swimlane?: string | undefined;
  action?: string | undefined;
  [key: string]: unknown;
}

/** Narrow an arbitrary (persisted / caller-supplied) value to the loose entry shape used
 *  throughout this file, or `undefined` for anything that isn't a non-null object — a primitive
 *  like `null`/a stray string tolerated by a malformed history array. Centralizes the
 *  `typeof x === 'object'` guard every helper below previously repeated ad hoc on an `any`. */
function asEntry(value: unknown): HistoryEntryLike | undefined {
  return value && typeof value === 'object' ? (value as HistoryEntryLike) : undefined;
}

// Trailing text chunks kept by compactSessionProgress — the tail of the
// agent's final message, the only raw output a later reader tends to need.
const COMPACT_TEXT_TAIL = 2;

// FLUX-1202: `tool` milestones carry a `data` payload (toolName + the raw call parameters —
// e.g. a full Edit's old_string/new_string) that's unbounded per call and, unlike `text` chunks,
// was never trimmed. A single long session can rack up thousands of tool calls; on one live
// ticket this pushed `data` payloads to ~60% of a 1.3MB persisted history, making that ticket's
// loadTask() call a multi-second synchronous outlier. Keep `data` only on the most recent
// COMPACT_TOOL_DATA_TAIL tool entries — older ones keep their human-readable `message` (the
// transcript stays readable) but drop the raw parameters.
const COMPACT_TOOL_DATA_TAIL = 20;

/**
 * Compact a finished session's progress log in place. Raw `text` flush chunks
 * (one per ~1s of agent output) are dropped in favor of typed milestones
 * (`tool`, `topic`, `info`), error-looking entries, and the last few text
 * chunks; the last text chunk is promoted to `finalMessage`. Typed milestones
 * keep their `message` indefinitely, but a `tool` entry's `data` payload is
 * dropped once it falls outside the most recent COMPACT_TOOL_DATA_TAIL tool
 * calls (see above). `originalProgressCount` records the largest raw length
 * seen. No-op on active sessions. Idempotent — stop paths can persist the
 * terminal status before the adapter's exit handler flushes the accumulated
 * progress, so this may run more than once per entry and must compact
 * late-arriving chunks too.
 *
 * Returns whether the entry was actually mutated, so a caller that runs this
 * over many entries (e.g. the retroactive load-time pass in task-store.ts)
 * can tell whether a write-back is warranted without diffing the whole
 * history array itself.
 */
export function compactSessionProgress(entry: unknown): boolean {
  const session = asEntry(entry);
  if (!session || session.type !== 'agent_session' || session.status === 'active') return false;
  if (!Array.isArray(session.progress)) return false;

  const progress: AgentSessionProgress[] = session.progress;
  const isText = (p: AgentSessionProgress) => p && (p.type === 'text' || p.type == null) && typeof p.message === 'string' && p.message.trim();
  const looksLikeError = (p: AgentSessionProgress) => {
    const data = p?.data;
    const dataError = data && typeof data === 'object' ? (data as Record<string, unknown>).error : undefined;
    return dataError != null || (typeof p?.message === 'string' && /^(error|fatal)\b/i.test(p.message.trim()));
  };
  const textEntries = progress.filter(isText);
  const keptTail = new Set(textEntries.slice(-COMPACT_TEXT_TAIL));

  const dataToolEntries = progress.filter((p) => p?.type === 'tool' && p.data !== undefined);
  const keptDataTail = new Set(dataToolEntries.slice(-COMPACT_TOOL_DATA_TAIL));

  let dataStripped = false;
  const nextProgress = progress
    .filter((p) => (p?.type && p.type !== 'text') || keptTail.has(p) || looksLikeError(p))
    .map((p) => {
      if (p?.type !== 'tool' || p.data === undefined || keptDataTail.has(p) || looksLikeError(p)) return p;
      dataStripped = true;
      const { data: _data, ...rest } = p;
      return rest;
    });
  const progressChanged = dataStripped || nextProgress.length !== progress.length;
  session.progress = nextProgress;

  const priorOriginalCount = session.originalProgressCount ?? 0;
  session.originalProgressCount = Math.max(priorOriginalCount, progress.length);
  const originalCountChanged = session.originalProgressCount !== priorOriginalCount;

  const finalMessage = textEntries.length > 0 ? textEntries[textEntries.length - 1]!.message : undefined;
  const finalMessageChanged = finalMessage != null && session.finalMessage == null;
  if (finalMessageChanged) session.finalMessage = finalMessage;

  return progressChanged || originalCountChanged || finalMessageChanged;
}

/**
 * Digest + window a ticket's history for agent consumption. `agent_session`
 * entries lose their `progress[]` array (per-second output noise from prior
 * sessions — the dominant weight on heavily-worked tickets) in favor of a
 * `progressCount`; only the most recent `limit` entries are returned, with the
 * number of omitted older entries in `olderHistoryEntries`.
 */
export function digestHistoryForAgent(
  history: unknown[] = [],
  limit: number,
  keepRecent = 3,
  opts: { expand?: string[] | undefined; fullHistory?: boolean | undefined } = {},
): { history: HistoryEntryLike[]; olderHistoryEntries: number; collapsedCount?: number } {
  // Drop status_change entries from the agent digest — the current status is
  // already in the frontmatter and the transition log is rarely actionable to a
  // reading agent. Comments (incl. reviewer handoffs) and activity (incl. agent
  // log_progress notes) are kept. (FLUX-499)
  const material = history.filter((entry) => asEntry(entry)?.type !== 'status_change');
  const digested = material.map((entry): HistoryEntryLike => {
    const e = asEntry(entry);
    // Malformed/non-object entries pass through unchanged (same tolerant contract the old
    // `any[]` signature had) — the cast reflects that history entries are always objects in
    // practice (schema.ts enforces this at write time); this branch also covers the common
    // case of a well-formed non-agent_session entry, which already satisfies the shape.
    if (!e || e.type !== 'agent_session') return entry as HistoryEntryLike;
    const { progress, ...rest } = e;
    return { ...rest, progressCount: Array.isArray(progress) ? progress.length : 0 };
  });
  const cap = Math.max(1, limit);
  const windowed = digested.length > cap ? digested.slice(-cap) : digested;
  const olderHistoryEntries = digested.length - windowed.length;

  // fullHistory escape (FLUX-504): windowed digest WITHOUT summary-collapse.
  // Discouraged (defeats the digest) — prefer expand:[ids].
  if (opts.fullHistory) {
    return { history: windowed, olderHistoryEntries };
  }

  const expandSet = new Set(opts.expand ?? []);

  // Temporal supersession (FLUX-811): map each entry id → the LATER entry that
  // explicitly supersedes it (`supersedes: [ids]`). A supersession only counts
  // when the superseder sits after its target in history — recency is the whole
  // point. We keep the superseder's id (for the marker) and its author (for the
  // authority guardrail). The latest superseder wins if several point at one id.
  const positionById = new Map<string, number>();
  material.forEach((entry, i) => {
    const e = asEntry(entry);
    if (e && typeof e.id === 'string') positionById.set(e.id, i);
  });
  const supersededBy = new Map<string, { by: string; byUser: unknown }>();
  material.forEach((entry, i) => {
    const e = asEntry(entry);
    if (!e || !Array.isArray(e.supersedes)) return;
    const supersederId = typeof e.id === 'string' ? e.id : '(superseded)';
    for (const targetId of e.supersedes) {
      if (typeof targetId !== 'string') continue;
      const targetPos = positionById.get(targetId);
      if (targetPos == null || targetPos >= i) continue; // superseder must be later
      supersededBy.set(targetId, { by: supersederId, byUser: e.user });
    }
  });

  // Summary-gated collapse (FLUX-501/503): within the window, replace OLDER
  // entries that carry an agent-written `summary` AND an `id` (to expand by)
  // with just that summary + metadata + id. Kept FULL: the last `keepRecent`,
  // any `pin:true`, any entry WITHOUT a summary (we never force-truncate), and
  // any entry without an `id` (it couldn't be recovered via expand). User
  // comments are kept full implicitly — users don't write summaries.
  const recentStart = Math.max(0, windowed.length - Math.max(0, keepRecent));
  let collapsedCount = 0;
  const collapsedHistory = windowed.map((entry, i): HistoryEntryLike => {
    const e = asEntry(entry);
    if (!e) return entry as HistoryEntryLike;

    // Temporal supersession (FLUX-811) — checked BEFORE the recent-window: a dead
    // decision should collapse even if it's recent, so the next session reads the
    // live state, not the abandoned plan. Authority-before-recency guardrail (the
    // paper's #1 finding): an AGENT's supersession must NEVER bury a pinned or
    // user-authored target — keep it full with an advisory annotation instead.
    // Same exemptions as the summary-collapse path below. Still recoverable via
    // expand:[id] like any collapse.
    const superseder = e.id ? supersededBy.get(e.id) : undefined;
    if (superseder && !(e.id && expandSet.has(e.id))) {
      const protectedTarget = !!e.pin || !isAgentAuthor(e.user);
      if (protectedTarget && isAgentAuthor(superseder.byUser)) {
        return { ...e, supersededByAdvisory: superseder.by };       // advisory only → full
      }
      collapsedCount++;
      return {
        type: e.type,
        ...(e.user ? { user: e.user } : {}),
        date: e.date,
        supersededBy: superseder.by,
        ...(typeof e.summary === 'string' && e.summary.trim() ? { summary: e.summary } : {}),
        ...(e.id ? { id: e.id } : {}),
        collapsed: true,
      };
    }

    if (i >= recentStart) return entry as HistoryEntryLike;              // recent → full
    if (e.pin) return entry as HistoryEntryLike;                         // pinned → full
    if (e.id && expandSet.has(e.id)) return entry as HistoryEntryLike;   // explicitly expanded → full

    // agent_session: collapse old sessions to their `outcome` (keep sessionId so
    // get_session_log still works). FLUX-507.
    if (e.type === 'agent_session') {
      if (typeof e.outcome !== 'string' || !e.outcome.trim()) return entry as HistoryEntryLike; // no outcome → keep digested
      collapsedCount++;
      return {
        type: 'agent_session',
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(e.status ? { status: e.status } : {}),
        date: e.date,
        summary: e.outcome,
        ...(typeof e.progressCount === 'number' ? { progressCount: e.progressCount } : {}),
        collapsed: true,
      };
    }

    if (!e.id) return entry as HistoryEntryLike;                        // no expandable handle → keep full (FLUX-504 safety: never collapse what can't be recovered via expand:[id]; e.g. activity entries get no id)
    if (typeof e.summary !== 'string' || !e.summary.trim()) return entry as HistoryEntryLike; // no summary → full
    collapsedCount++;
    return {
      type: e.type,
      user: e.user,
      date: e.date,
      summary: e.summary,
      id: e.id,
      collapsed: true,
    };
  });

  return {
    history: collapsedHistory,
    olderHistoryEntries,
    ...(collapsedCount > 0 ? { collapsedCount } : {}),
  };
}

// ── User-comment & launch-focus surfacing (FLUX-480) ────────────────────────

// Agents write ticket history with `user: 'Agent'` — that is the canonical
// marker (the MCP `add_comment` default and every engine write path). Some
// agent sessions post under a model/framework display name instead. We bias
// toward treating an author as a USER when uncertain: surfacing one extra agent
// comment is harmless, while dropping a real user instruction is exactly the
// bug FLUX-480 guards against.
// FLUX-905 (audit C.17): built from the framework + model-family names (MODEL_FAMILIES in
// agents/types.ts) instead of a hardcoded list — a new framework/model is one edit there, not here.
const AGENT_AUTHOR_TOKENS = ['agent', ...new Set(Object.values(MODEL_FAMILIES).flat())];
const AGENT_AUTHOR_PATTERN = new RegExp(`\\b(${AGENT_AUTHOR_TOKENS.join('|')})\\b`, 'i');

export function isAgentAuthor(user: unknown): boolean {
  if (typeof user !== 'string') return false;
  const u = user.trim();
  if (!u) return false;
  return u === 'Agent' || AGENT_AUTHOR_PATTERN.test(u);
}

export interface RecentUserComment {
  user: string;
  date: string;
  comment: string;
  id?: string;
}

/** A comment-type HistoryEntryLike narrowed to a definite `comment` string — the shape
 *  extractRecentUserComments' filter guarantees before building a RecentUserComment. */
interface UserCommentEntry extends HistoryEntryLike {
  comment: string;
}

/**
 * Scan the FULL history (not just the windowed digest) for the last `limit`
 * user-authored `comment` entries. A user comment older than the agent's
 * ~20-entry history window would otherwise be silently invisible (FLUX-480);
 * this pins the most recent few so the agent always sees them.
 */
export function extractRecentUserComments(history: unknown[] = [], limit = 3): RecentUserComment[] {
  const cap = Math.max(0, limit);
  if (cap === 0) return [];
  const userComments = history
    .map(asEntry)
    .filter((e): e is UserCommentEntry => !!e && e.type === 'comment' && typeof e.comment === 'string' && !isAgentAuthor(e.user));
  return userComments.slice(-cap).map((e) => ({
    user: typeof e.user === 'string' ? e.user : '',
    date: e.date ?? '',
    comment: e.comment,
    ...(e.id ? { id: e.id } : {}),
  }));
}

/**
 * The most recent persisted launch-focus instruction, if any. Persisted as a
 * `launchFocus` field on a launch activity entry (routes/cli-session.ts). Only
 * the clean focus text is ever stored — never the full launch-prompt blob,
 * which FLUX-473 deliberately stripped from the agent digest.
 */
export function extractLaunchFocus(history: unknown[] = []): { launchFocus: string; date: string } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = asEntry(history[i]);
    if (e && typeof e.launchFocus === 'string' && e.launchFocus.trim()) {
      return { launchFocus: e.launchFocus.trim(), date: e.date ?? '' };
    }
  }
  return undefined;
}

/**
 * Strip `progress[]` from terminal (non-active) `agent_session` entries for
 * the board list payload. Nothing on the board reads a finished session's
 * progress — cards only render the active session's last entry, and the modal
 * re-fetches the full ticket from the detail endpoint. Active entries keep
 * their array because SSE progress events append into it live.
 */
export function digestTerminalSessionProgress(history: unknown[] = []): HistoryEntryLike[] {
  return history.map((entry): HistoryEntryLike => {
    const e = asEntry(entry);
    if (!e || e.type !== 'agent_session' || e.status === 'active') return entry as HistoryEntryLike;
    const { progress, ...rest } = e;
    return { ...rest, progressCount: Array.isArray(progress) ? progress.length : 0 };
  });
}

/**
 * Compact, board-card-facing digest of a ticket's history (FLUX-725). The `/api/tasks`
 * list payload ships THIS instead of the raw `history[]` array (fetched + parsed on every
 * ~3s poll / `taskUpdated` SSE), so a large board no longer pays the per-ticket history
 * parse/GC cost. Every signal the board cards + attention surfaces derive from history is
 * pre-computed here from the FULL history; the modal/chat lazy-fetch the detail endpoint
 * (`serializeTaskForApi`, full `history`) for the activity log. Keep it strictly DERIVED —
 * no new persisted ticket fields. The 24h window mirrors the board readers' own cutoffs.
 */
export interface HistoryDigest {
  /** Total entry count — change-detection (`tasksEqual`) + "has any history" checks. */
  length: number;
  /** The last array element's identity — `tasksEqual`'s last-entry key. */
  lastEntry: { date: string; type: string } | null;
  /** Max entry date (ticket-age "rust" + Epics "recently active" sort). */
  lastActivityAt: string;
  /** Date of the most recent status_change INTO the current status (time-in-column),
   *  or null when the ticket was created directly in its status (chip hidden). */
  enteredCurrentStatusAt: string | null;
  /** In-progress → done in under 2h (the "speed demon" ⚡), derived from full history so a
   *  done card older than 24h still qualifies (the 24h window below can't carry this). */
  isSpeedDemon: boolean;
  /** status_change entries within the last 24h — the board-wide flow arrows + done-streak. */
  statusChanges24h: Array<{ from: string; to: string; date: string }>;
  /** Comment entries with an id — per-column + global unread badges (author needed for the
   *  own-vs-other filter; the engine can't know `currentUser`). Comment TEXT is omitted. */
  comments: Array<{ id: string; user: string; date: string }>;
  /** Pre-computed Require-Input question + set-date (attention dock). Only populated for a
   *  ticket actually in the require-input swimlane, so question text isn't shipped board-wide. */
  requireInput: { question: string; setDate: string } | null;
  /** FLUX-1289: the plan-review gate's latest feedback comment — the AttentionDock's plan-approval
   *  item and ChatPlanApprovalCard surface this inline so a `changes-requested` verdict's actual
   *  wording is visible without opening full history. Only populated when `planReviewState` is set
   *  (mirrors `requireInput`'s conditional), so comment text isn't shipped board-wide otherwise.
   *  FLUX-1303: carries `user` so surfaces attribute the feedback (reviewer vs the human's own
   *  re-groom notes) instead of rendering an anonymous blob. */
  planReviewComment: { text: string; date: string; user: string } | null;
}

/** Server-side twin of the portal's `requireInputMeta` (pendingInteractions.tsx): the question
 *  is the comment on the latest `swimlane_change → set require-input` entry, falling back to the
 *  most recent comment, then a default. Replicated here so the attention dock reads it off the
 *  digest instead of pulling full history. */
function computeRequireInputMeta(entries: unknown[]): { question: string; setDate: string } {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = asEntry(entries[i]);
    if (e?.type === 'swimlane_change' && e.action === 'set' && e.swimlane === 'require-input') {
      return {
        question: typeof e.comment === 'string' && e.comment ? e.comment : 'This ticket is waiting for your input.',
        setDate: e.date ?? '',
      };
    }
  }
  let question = 'This ticket is waiting for your input.';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = asEntry(entries[i]);
    if (e?.type === 'comment' && typeof e.comment === 'string' && e.comment) { question = e.comment; break; }
  }
  return { question, setDate: '' };
}

/** Server-side twin of the portal's fallback in `planReviewFeedback` (pendingInteractions.tsx): the
 *  most recent comment entry is the plan-review verdict's feedback — true for both the human
 *  send-back path (`PlanApprovalPanel`) and the auto-review agent's own comment, which is always
 *  posted immediately before the `change_status` call that records the verdict. */
function computePlanReviewComment(entries: unknown[]): { text: string; date: string; user: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = asEntry(entries[i]);
    if (e?.type === 'comment' && typeof e.comment === 'string' && e.comment) {
      return {
        text: e.comment,
        date: typeof e.date === 'string' ? e.date : '',
        user: typeof e.user === 'string' && e.user ? e.user : 'Agent',
      };
    }
  }
  return null;
}

export function buildHistoryDigest(
  history: unknown[] = [],
  status: string,
  swimlane?: string | null,
  now: number = Date.now(),
  // FLUX-957: optional per-entry hook so callers that also need a filtered view of the raw
  // history (e.g. serializeTaskForList's inline comment/active-session entries) can collect it
  // in this same pass instead of a separate O(n) `.filter`. Never touches the returned digest.
  onEntry?: (entry: HistoryEntryLike) => void,
  // FLUX-1289: trailing (not inserted earlier) so existing positional callers/tests are undisturbed.
  planReviewState?: string | null,
): HistoryDigest {
  const entries = Array.isArray(history) ? history : [];
  const cutoff = now - 86_400_000; // 24h, matching Board.tsx flow/streak cutoffs
  let lastActivityAt = '';
  let enteredCurrentStatusAt: string | null = null;
  let firstInProgressAt: number | undefined;
  let lastDoneAt: number | undefined;
  const statusChanges24h: Array<{ from: string; to: string; date: string }> = [];
  const comments: Array<{ id: string; user: string; date: string }> = [];

  for (const raw of entries) {
    const e = asEntry(raw);
    if (!e) continue;
    onEntry?.(e);
    const date: string = typeof e.date === 'string' ? e.date : '';
    // ISO-8601 strings compare lexicographically == chronologically (matches the readers).
    if (date && date > lastActivityAt) lastActivityAt = date;

    if (e.type === 'status_change') {
      const from = e.from;
      const to = e.to;
      // Last (most recent) move into the current status wins — equivalent to the readers'
      // backwards walk that breaks on the first match.
      if (date && to === status) enteredCurrentStatusAt = date;
      const t = date ? new Date(date).getTime() : NaN;
      if (!Number.isNaN(t)) {
        if (t >= cutoff && from && to) statusChanges24h.push({ from, to, date });
        if (/in.?progress/i.test(to ?? '') && firstInProgressAt === undefined) firstInProgressAt = t;
        if (/done/i.test(to ?? '')) lastDoneAt = t;
      }
    } else if (e.type === 'comment' && e.id) {
      comments.push({ id: e.id, user: typeof e.user === 'string' ? e.user : '', date });
    }
  }

  const isSpeedDemon =
    firstInProgressAt !== undefined &&
    lastDoneAt !== undefined &&
    lastDoneAt - firstInProgressAt < 2 * 60 * 60 * 1000;

  const lastRaw = entries.length > 0 ? entries[entries.length - 1] : null;
  const last = asEntry(lastRaw);
  const lastEntry = last
    ? { date: typeof last.date === 'string' ? last.date : '', type: typeof last.type === 'string' ? last.type : '' }
    : null;

  return {
    length: entries.length,
    lastEntry,
    lastActivityAt,
    enteredCurrentStatusAt,
    isSpeedDemon,
    statusChanges24h,
    comments,
    requireInput: swimlane === 'require-input' ? computeRequireInputMeta(entries) : null,
    planReviewComment: planReviewState != null ? computePlanReviewComment(entries) : null,
  };
}

function buildCommentId(seed: string, usedIds: Set<string>, prefix = 'c') {
  const normalizedSeed = seed.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'entry';
  let candidate = `${prefix}-${normalizedSeed}`;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${prefix}-${normalizedSeed}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

export function getHistoryTimestamp(entry: unknown): number {
  const date = asEntry(entry)?.date;
  if (!date) return 0;
  const timestamp = new Date(date).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function findEarliestHistoryDate(history: unknown[] = []): string | undefined {
  const timestamps = history
    .map((entry) => getHistoryTimestamp(entry))
    .filter((timestamp) => timestamp > 0);

  if (timestamps.length === 0) return undefined;
  return new Date(Math.min(...timestamps)).toISOString();
}

export function ensureCreationActivity(history: unknown[] = [], user: string, fallbackDate?: string): { history: HistoryEntryLike[]; changed: boolean } {
  const hasCreationActivity = history.some((entry) => {
    const e = asEntry(entry);
    return e?.type === 'activity' && e?.comment === 'Created ticket.';
  });

  if (hasCreationActivity) {
    // The pass-through entries are only ever objects when this branch is reached (the `.some()`
    // above already required an object shape to match), but malformed non-object entries earlier
    // in the array are tolerated as-is — same loose contract the old `any[]` signature had.
    return { history: history as HistoryEntryLike[], changed: false };
  }

  const createdAt = findEarliestHistoryDate(history) || fallbackDate || new Date().toISOString();
  return {
    history: [buildActivityEntry('Created ticket.', user || 'Unknown', createdAt), ...history] as HistoryEntryLike[],
    changed: true,
  };
}

function valuesMatch(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  if (typeof value === 'string') return value.trim() || 'none';
  if (value == null) return 'none';
  return String(value);
}

function normalizeTextContent(value: unknown) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trimEnd() : '';
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item != null && String(item).trim() !== '')
    .map((item) => String(item));
}

/** Minimal shape of a ticket's frontmatter as read by summarizeFieldChanges — there is no
 *  canonical compile-time type for ticket frontmatter either (see routes/tasks.ts's own local
 *  `TaskRecord` for the same rationale); every other field flows through via the index signature. */
interface FieldChangeSource {
  title?: unknown;
  body?: unknown;
  assignee?: unknown;
  tags?: unknown;
  priority?: unknown;
  effort?: unknown;
  implementationLink?: unknown;
  subtasks?: unknown;
  [key: string]: unknown;
}

export function summarizeFieldChanges(previousTask: FieldChangeSource, nextFrontmatter: FieldChangeSource, nextBody: string | undefined): string[] {
  const messages: string[] = [];
  const previousBody = normalizeTextContent(previousTask.body);
  const normalizedNextBody = normalizeTextContent(nextBody);
  const previousTags = normalizeStringList(previousTask.tags);
  const nextTags = normalizeStringList(nextFrontmatter.tags);
  const previousSubtasks = normalizeStringList(previousTask.subtasks);
  const nextSubtasks = normalizeStringList(nextFrontmatter.subtasks);

  if ((previousTask.title || '') !== (nextFrontmatter.title || '')) messages.push('Updated title.');
  if (previousBody !== normalizedNextBody) messages.push('Updated description.');
  if ((previousTask.assignee || 'unassigned') !== (nextFrontmatter.assignee || 'unassigned')) {
    messages.push(`Changed assignee from ${formatValue(previousTask.assignee || 'unassigned')} to ${formatValue(nextFrontmatter.assignee || 'unassigned')}.`);
  }
  if (!valuesMatch(previousTags, nextTags)) messages.push(`Updated tags to ${formatValue(nextTags)}.`);
  if ((previousTask.priority || 'None') !== (nextFrontmatter.priority || 'None')) {
    messages.push(`Changed priority from ${formatValue(previousTask.priority || 'None')} to ${formatValue(nextFrontmatter.priority || 'None')}.`);
  }
  if ((previousTask.effort || 'None') !== (nextFrontmatter.effort || 'None')) {
    messages.push(`Changed effort from ${formatValue(previousTask.effort || 'None')} to ${formatValue(nextFrontmatter.effort || 'None')}.`);
  }
  if ((previousTask.implementationLink || '') !== (nextFrontmatter.implementationLink || '')) {
    messages.push(nextFrontmatter.implementationLink ? 'Updated implementation link.' : 'Cleared implementation link.');
  }
  if (!valuesMatch(previousSubtasks, nextSubtasks)) messages.push('Updated subtasks.');

  return messages;
}

/** Recursive, key-order-independent JSON serialization — used only to build an equality
 *  signature for history entries, never for storage. Plain `JSON.stringify` with a key-array
 *  replacer would DROP any nested key not named at the top level (e.g. an `agent_session`
 *  entry's `progress[].data`), silently collapsing distinct entries onto the same signature. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FLUX-1308: identity for a history entry — its persisted `id` where present (comment/activity
 *  entries always have one, FLUX-811), else a content signature. Entry types with no `id`
 *  (status_change, swimlane_change, agent_session, ...) fall back to the signature; content
 *  equality is the only identity available for them. */
function historyEntryIdentity(entry: HistoryEntryLike): string {
  if (typeof entry.id === 'string' && entry.id.trim()) return `id:${entry.id.trim()}`;
  return `sig:${stableStringify(entry)}`;
}

/**
 * FLUX-1308: reconcile a client-submitted full `history` array against the server's copy by
 * entry IDENTITY instead of array length/position. The old `nextHistory.slice(existingHistory
 * .length)` treated "everything past the server's current length" as novel — but a client
 * snapshot stale by N entries submits a SHORTER array, so the slice point lands inside the
 * client's own new entries and silently drops the first N of them. Returns only the entries in
 * `nextHistory` that don't match any existing entry; existing entries are never dropped by
 * omission, and reordering/staleness in the client's copy can no longer lose a novel entry.
 */
export function reconcileNovelHistoryEntries(existingHistory: unknown[] = [], nextHistory: unknown[] = []): HistoryEntryLike[] {
  const existingIdentities = new Set<string>();
  for (const raw of existingHistory) {
    const entry = asEntry(raw);
    if (entry) existingIdentities.add(historyEntryIdentity(entry));
  }

  const novel: HistoryEntryLike[] = [];
  for (const raw of nextHistory) {
    const entry = asEntry(raw);
    if (!entry) {
      // Malformed/non-object entries never originate from a real writer — same tolerant
      // pass-through contract as normalizeHistoryEntries above.
      novel.push(raw as HistoryEntryLike);
      continue;
    }
    if (!existingIdentities.has(historyEntryIdentity(entry))) novel.push(entry);
  }
  return novel;
}

export function normalizeHistoryEntries(history: unknown[] = []): { history: HistoryEntryLike[]; changed: boolean } {
  let changed = false;
  const usedIds = new Set<string>();

  // FLUX-811: the set of ids already present in the input — supersession links
  // may only reference an EXISTING entry. Built from input ids (a freshly
  // assigned id can't be a supersede target: nothing could have referenced it
  // when the link was written), so this naturally drops dangling/forward-to-new
  // and self references without a positional scan.
  const existingIds = new Set<string>();
  for (const raw of history) {
    const entry = asEntry(raw);
    if (entry && typeof entry.id === 'string' && entry.id.trim()) {
      existingIds.add(entry.id.trim());
    }
  }

  const normalized = history.map((raw, index) => {
    const entry = asEntry(raw);
    // Malformed/non-object entries pass through unchanged — same tolerant contract the old
    // `any[]` signature had. Cast is safe: real history entries are always objects (schema.ts
    // enforces this at write time); this branch only ever sees already-corrupt data we don't
    // want to crash on.
    if (!entry) return raw as HistoryEntryLike;

    const nextEntry: HistoryEntryLike = { ...entry };

    if (typeof nextEntry.id === 'string' && nextEntry.id.trim()) {
      const trimmedId = nextEntry.id.trim();
      if (trimmedId !== nextEntry.id) {
        nextEntry.id = trimmedId;
        changed = true;
      }
      usedIds.add(nextEntry.id);
    }

    if (!nextEntry.date) {
      nextEntry.date = new Date().toISOString();
      changed = true;
    }

    // Assign a stable, collision-safe id to comment AND activity entries so the
    // agent digest can collapse old summarized entries and recover them via
    // expand:[id]. Activity entries previously had no id, so a `summary` written
    // on log_progress was inert for the digest (FLUX-526).
    if (nextEntry.type === 'comment' || nextEntry.type === 'activity') {
      if (!nextEntry.id) {
        const seed = nextEntry.date || `${Date.now()}-${index + 1}`;
        nextEntry.id = buildCommentId(seed, usedIds, nextEntry.type === 'activity' ? 'a' : 'c');
        changed = true;
      }

      // FLUX-811: temporal supersession links. Coerce `supersedes` to a string[]
      // of EXISTING entry ids — drop non-strings, self-references, and danglers
      // so the digest never points at a missing target. Empty ⇒ field removed.
      if ('supersedes' in nextEntry) {
        const rawSupersedes: unknown[] = Array.isArray(nextEntry.supersedes)
          ? nextEntry.supersedes
          : typeof nextEntry.supersedes === 'string'
            ? [nextEntry.supersedes]
            : [];
        const cleaned = Array.from(
          new Set(
            rawSupersedes
              .filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '')
              .map((id: string) => id.trim())
              .filter((id: string) => id !== nextEntry.id && existingIds.has(id)),
          ),
        );
        if (cleaned.length > 0) {
          if (!valuesMatch(cleaned, nextEntry.supersedes)) {
            nextEntry.supersedes = cleaned;
            changed = true;
          }
        } else {
          delete nextEntry.supersedes;
          changed = true;
        }
      }
    }

    if (nextEntry.type === 'comment') {
      if (nextEntry.replyTo != null && typeof nextEntry.replyTo !== 'string') {
        delete nextEntry.replyTo;
        changed = true;
      }
    }

    if (nextEntry.type === 'status_change') {
      if (nextEntry.from == null && typeof nextEntry.oldStatus === 'string') {
        nextEntry.from = nextEntry.oldStatus;
        delete nextEntry.oldStatus;
        changed = true;
      }
      if (nextEntry.to == null && typeof nextEntry.newStatus === 'string') {
        nextEntry.to = nextEntry.newStatus;
        delete nextEntry.newStatus;
        changed = true;
      }
    }

    return nextEntry;
  });

  return { history: normalized, changed };
}
