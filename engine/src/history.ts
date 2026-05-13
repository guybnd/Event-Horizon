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
}

export interface AgentSessionEntry {
  type: 'agent_session';
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  outcome?: string;
  progress: AgentSessionProgress[];
  user: string;
  date: string;
}

export function buildAgentSessionEntry(
  sessionId: string,
  startedAt: string,
  label: string,
): AgentSessionEntry {
  return {
    type: 'agent_session',
    sessionId,
    startedAt,
    status: 'active',
    progress: [],
    user: label,
    date: startedAt,
  };
}

export function appendSessionProgress(
  session: AgentSessionEntry,
  message: string,
  timestamp: string,
): void {
  session.progress.push({ timestamp, message });
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

function getHistoryTimestamp(entry: any) {
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

    return nextEntry;
  });

  return { history: normalized, changed };
}
