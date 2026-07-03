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
  data?: any;
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

// Trailing text chunks kept by compactSessionProgress — the tail of the
// agent's final message, the only raw output a later reader tends to need.
const COMPACT_TEXT_TAIL = 2;

/**
 * Compact a finished session's progress log in place. Raw `text` flush chunks
 * (one per ~1s of agent output) are dropped in favor of typed milestones
 * (`tool`, `topic`, `info`), error-looking entries, and the last few text
 * chunks; the last text chunk is promoted to `finalMessage`.
 * `originalProgressCount` records the largest raw length seen. No-op on
 * active sessions. Idempotent — stop paths can persist the terminal status
 * before the adapter's exit handler flushes the accumulated progress, so this
 * may run more than once per entry and must compact late-arriving chunks too.
 */
export function compactSessionProgress(entry: any): void {
  if (!entry || entry.type !== 'agent_session' || entry.status === 'active') return;
  if (!Array.isArray(entry.progress)) return;

  const progress: any[] = entry.progress;
  const isText = (p: any) => p && (p.type === 'text' || p.type == null) && typeof p.message === 'string' && p.message.trim();
  const looksLikeError = (p: any) => p?.data?.error != null || (typeof p?.message === 'string' && /^(error|fatal)\b/i.test(p.message.trim()));
  const textEntries = progress.filter(isText);
  const keptTail = new Set(textEntries.slice(-COMPACT_TEXT_TAIL));

  entry.progress = progress.filter((p: any) => (p?.type && p.type !== 'text') || keptTail.has(p) || looksLikeError(p));
  entry.originalProgressCount = Math.max(entry.originalProgressCount ?? 0, progress.length);
  const finalMessage = textEntries.length > 0 ? textEntries[textEntries.length - 1].message : undefined;
  if (finalMessage && entry.finalMessage == null) entry.finalMessage = finalMessage;
}

export function closeAgentSession(
  session: AgentSessionEntry,
  status: 'completed' | 'failed' | 'cancelled',
  outcome: string,
  endedAt: string,
): void {
  session.status = status;
  session.outcome = outcome;
  session.endedAt = endedAt;
}

/**
 * Digest + window a ticket's history for agent consumption. `agent_session`
 * entries lose their `progress[]` array (per-second output noise from prior
 * sessions — the dominant weight on heavily-worked tickets) in favor of a
 * `progressCount`; only the most recent `limit` entries are returned, with the
 * number of omitted older entries in `olderHistoryEntries`.
 */
export function digestHistoryForAgent(
  history: any[] = [],
  limit: number,
  keepRecent = 3,
  opts: { expand?: string[] | undefined; fullHistory?: boolean | undefined } = {},
) {
  // Drop status_change entries from the agent digest — the current status is
  // already in the frontmatter and the transition log is rarely actionable to a
  // reading agent. Comments (incl. reviewer handoffs) and activity (incl. agent
  // log_progress notes) are kept. (FLUX-499)
  const material = history.filter((entry) => !entry || entry.type !== 'status_change');
  const digested = material.map((entry) => {
    if (!entry || entry.type !== 'agent_session') return entry;
    const { progress, ...rest } = entry;
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
    if (entry && typeof entry === 'object' && typeof entry.id === 'string') positionById.set(entry.id, i);
  });
  const supersededBy = new Map<string, { by: string; byUser: unknown }>();
  material.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.supersedes)) return;
    const supersederId = typeof entry.id === 'string' ? entry.id : '(superseded)';
    for (const targetId of entry.supersedes) {
      if (typeof targetId !== 'string') continue;
      const targetPos = positionById.get(targetId);
      if (targetPos == null || targetPos >= i) continue; // superseder must be later
      supersededBy.set(targetId, { by: supersederId, byUser: entry.user });
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
  const collapsedHistory = windowed.map((entry, i) => {
    if (!entry || typeof entry !== 'object') return entry;

    // Temporal supersession (FLUX-811) — checked BEFORE the recent-window: a dead
    // decision should collapse even if it's recent, so the next session reads the
    // live state, not the abandoned plan. Authority-before-recency guardrail (the
    // paper's #1 finding): an AGENT's supersession must NEVER bury a pinned or
    // user-authored target — keep it full with an advisory annotation instead.
    // Same exemptions as the summary-collapse path below. Still recoverable via
    // expand:[id] like any collapse.
    const superseder = entry.id ? supersededBy.get(entry.id) : undefined;
    if (superseder && !(entry.id && expandSet.has(entry.id))) {
      const protectedTarget = !!entry.pin || !isAgentAuthor(entry.user);
      if (protectedTarget && isAgentAuthor(superseder.byUser)) {
        return { ...entry, supersededByAdvisory: superseder.by };       // advisory only → full
      }
      collapsedCount++;
      return {
        type: entry.type,
        ...(entry.user ? { user: entry.user } : {}),
        date: entry.date,
        supersededBy: superseder.by,
        ...(typeof entry.summary === 'string' && entry.summary.trim() ? { summary: entry.summary } : {}),
        ...(entry.id ? { id: entry.id } : {}),
        collapsed: true,
      };
    }

    if (i >= recentStart) return entry;                                  // recent → full
    if (entry.pin) return entry;                                          // pinned → full
    if (entry.id && expandSet.has(entry.id)) return entry;               // explicitly expanded → full

    // agent_session: collapse old sessions to their `outcome` (keep sessionId so
    // get_session_log still works). FLUX-507.
    if (entry.type === 'agent_session') {
      if (typeof entry.outcome !== 'string' || !entry.outcome.trim()) return entry; // no outcome → keep digested
      collapsedCount++;
      return {
        type: 'agent_session',
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        date: entry.date,
        summary: entry.outcome,
        ...(typeof entry.progressCount === 'number' ? { progressCount: entry.progressCount } : {}),
        collapsed: true,
      };
    }

    if (!entry.id) return entry;                                          // no expandable handle → keep full (FLUX-504 safety: never collapse what can't be recovered via expand:[id]; e.g. activity entries get no id)
    if (typeof entry.summary !== 'string' || !entry.summary.trim()) return entry; // no summary → full
    collapsedCount++;
    return {
      type: entry.type,
      user: entry.user,
      date: entry.date,
      summary: entry.summary,
      id: entry.id,
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

/**
 * Scan the FULL history (not just the windowed digest) for the last `limit`
 * user-authored `comment` entries. A user comment older than the agent's
 * ~20-entry history window would otherwise be silently invisible (FLUX-480);
 * this pins the most recent few so the agent always sees them.
 */
export function extractRecentUserComments(history: any[] = [], limit = 3): RecentUserComment[] {
  const cap = Math.max(0, limit);
  if (cap === 0) return [];
  const userComments = history.filter(
    (e) => e && e.type === 'comment' && typeof e.comment === 'string' && !isAgentAuthor(e.user),
  );
  return userComments.slice(-cap).map((e) => ({
    user: e.user,
    date: e.date,
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
export function extractLaunchFocus(history: any[] = []): { launchFocus: string; date: string } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e && typeof e.launchFocus === 'string' && e.launchFocus.trim()) {
      return { launchFocus: e.launchFocus.trim(), date: e.date };
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
export function digestTerminalSessionProgress(history: any[] = []) {
  return history.map((entry) => {
    if (!entry || entry.type !== 'agent_session' || entry.status === 'active') return entry;
    const { progress, ...rest } = entry;
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
}

/** Server-side twin of the portal's `requireInputMeta` (pendingInteractions.tsx): the question
 *  is the comment on the latest `swimlane_change → set require-input` entry, falling back to the
 *  most recent comment, then a default. Replicated here so the attention dock reads it off the
 *  digest instead of pulling full history. */
function computeRequireInputMeta(entries: any[]): { question: string; setDate: string } {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'swimlane_change' && e.action === 'set' && e.swimlane === 'require-input') {
      return { question: e.comment || 'This ticket is waiting for your input.', setDate: e.date ?? '' };
    }
  }
  let question = 'This ticket is waiting for your input.';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'comment' && e.comment) { question = e.comment; break; }
  }
  return { question, setDate: '' };
}

export function buildHistoryDigest(
  history: any[] = [],
  status: string,
  swimlane?: string | null,
  now: number = Date.now(),
): HistoryDigest {
  const entries = Array.isArray(history) ? history : [];
  const cutoff = now - 86_400_000; // 24h, matching Board.tsx flow/streak cutoffs
  let lastActivityAt = '';
  let enteredCurrentStatusAt: string | null = null;
  let firstInProgressAt: number | undefined;
  let lastDoneAt: number | undefined;
  const statusChanges24h: Array<{ from: string; to: string; date: string }> = [];
  const comments: Array<{ id: string; user: string; date: string }> = [];

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
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
      comments.push({ id: e.id, user: e.user ?? '', date });
    }
  }

  const isSpeedDemon =
    firstInProgressAt !== undefined &&
    lastDoneAt !== undefined &&
    lastDoneAt - firstInProgressAt < 2 * 60 * 60 * 1000;

  const last = entries.length > 0 ? entries[entries.length - 1] : null;
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

export function getHistoryTimestamp(entry: any) {
  if (!entry?.date) return 0;
  const timestamp = new Date(entry.date).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function findEarliestHistoryDate(history: any[] = []) {
  const timestamps = history
    .map((entry) => getHistoryTimestamp(entry))
    .filter((timestamp) => timestamp > 0);

  if (timestamps.length === 0) return undefined;
  return new Date(Math.min(...timestamps)).toISOString();
}

export function ensureCreationActivity(history: any[] = [], user: string, fallbackDate?: string) {
  const hasCreationActivity = history.some((entry) => entry?.type === 'activity' && entry?.comment === 'Created ticket.');

  if (hasCreationActivity) {
    return { history, changed: false };
  }

  const createdAt = findEarliestHistoryDate(history) || fallbackDate || new Date().toISOString();
  return {
    history: [buildActivityEntry('Created ticket.', user || 'Unknown', createdAt), ...history],
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

export function summarizeFieldChanges(previousTask: any, nextFrontmatter: any, nextBody: string | undefined) {
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

function historyPrefixMatches(existingHistory: any[] = [], nextHistory: any[] = []) {
  if (nextHistory.length < existingHistory.length) return false;
  return existingHistory.every((entry, index) => JSON.stringify(entry) === JSON.stringify(nextHistory[index]));
}

export function hasAppendedStatusChange(existingHistory: any[] = [], nextHistory: any[] = [], from?: string, to?: string) {
  if (!from || !to || !historyPrefixMatches(existingHistory, nextHistory)) return false;
  return nextHistory.slice(existingHistory.length).some(
    (entry) => entry?.type === 'status_change' && entry?.from === from && entry?.to === to,
  );
}

export function normalizeHistoryEntries(history: any[] = []) {
  let changed = false;
  const usedIds = new Set<string>();

  // FLUX-811: the set of ids already present in the input — supersession links
  // may only reference an EXISTING entry. Built from input ids (a freshly
  // assigned id can't be a supersede target: nothing could have referenced it
  // when the link was written), so this naturally drops dangling/forward-to-new
  // and self references without a positional scan.
  const existingIds = new Set<string>();
  for (const entry of history) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
      existingIds.add(entry.id.trim());
    }
  }

  const normalized = history.map((entry, index) => {
    if (!entry || typeof entry !== 'object') return entry;

    const nextEntry = { ...entry };

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
        const raw = Array.isArray(nextEntry.supersedes)
          ? nextEntry.supersedes
          : typeof nextEntry.supersedes === 'string'
            ? [nextEntry.supersedes]
            : [];
        const cleaned = Array.from(
          new Set(
            raw
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
