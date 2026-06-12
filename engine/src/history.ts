export function buildCommentEntry(user: string, comment: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'comment',
    user,
    date,
    comment,
    ...extra,
  };
}

export function buildActivityEntry(comment: string, user: string, date: string) {
  return {
    type: 'activity',
    user: user || 'Unknown',
    date,
    comment,
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
  group?: { groupId?: string; role?: string; pattern?: string },
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
export function digestHistoryForAgent(history: any[] = [], limit: number) {
  const digested = history.map((entry) => {
    if (!entry || entry.type !== 'agent_session') return entry;
    const { progress, ...rest } = entry;
    return { ...rest, progressCount: Array.isArray(progress) ? progress.length : 0 };
  });
  const cap = Math.max(1, limit);
  const windowed = digested.length > cap ? digested.slice(-cap) : digested;
  return { history: windowed, olderHistoryEntries: digested.length - windowed.length };
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

function buildCommentId(seed: string, usedIds: Set<string>) {
  const normalizedSeed = seed.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'comment';
  let candidate = `c-${normalizedSeed}`;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `c-${normalizedSeed}-${suffix}`;
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

    if (nextEntry.type === 'comment') {
      if (!nextEntry.id) {
        const seed = nextEntry.date || `${Date.now()}-${index + 1}`;
        nextEntry.id = buildCommentId(seed, usedIds);
        changed = true;
      }

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
