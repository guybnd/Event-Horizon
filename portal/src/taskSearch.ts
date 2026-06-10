import type { TaskSortOption } from './AppContext';
import type { Config, Task } from './types';

export interface TaskFilterState {
  searchQuery: string;
  sortOption: TaskSortOption;
  filterAssignee: string;
  filterPriority: string;
  filterTag: string;
  filterUnreadOnly?: boolean;
  readComments?: Record<string, string[]>;
  requireInputStatus?: string;
}

export interface TaskSearchResult {
  task: Task;
  score: number;
}

function normalizeText(value?: string) {
  return value?.toLowerCase().trim() || '';
}

function getTaskSearchableText(task: Task) {
  return {
    id: normalizeText(task.id),
    title: normalizeText(task.title),
    body: normalizeText(task.body),
    tags: normalizeText(task.tags?.join(' ')),
    assignee: normalizeText(task.assignee),
    status: normalizeText(task.status),
  };
}

function getSubsequenceScore(text: string, query: string) {
  if (!text || !query) {
    return 0;
  }

  let score = 0;
  let previousIndex = -1;

  for (const character of query) {
    const nextIndex = text.indexOf(character, previousIndex + 1);
    if (nextIndex === -1) {
      return 0;
    }

    const gap = previousIndex === -1 ? nextIndex : nextIndex - previousIndex - 1;
    score += gap === 0 ? 10 : Math.max(2, 6 - gap);
    previousIndex = nextIndex;
  }

  return score;
}

export function getTaskActivityTimestamp(task: Task) {
  return (task.history || []).reduce((latest, entry) => {
    const timestamp = entry.date ? new Date(entry.date).getTime() : 0;
    return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
  }, 0);
}

export function filterAndSortTasks(tasks: Task[], config: Config, filters: TaskFilterState) {
  const normalizedQuery = normalizeText(filters.searchQuery);
  const priorityOrder = new Map(config.priorities.map((priority, index) => [priority.name, index]));

  return tasks
    .filter((task) => {
      const title = normalizeText(task.title);
      const body = normalizeText(task.body);
      const id = normalizeText(task.id);
      const matchesQuery = !normalizedQuery || title.includes(normalizedQuery) || body.includes(normalizedQuery) || id.includes(normalizedQuery);
      const matchesAssignee = filters.filterAssignee === 'all' || (task.assignee || 'unassigned') === filters.filterAssignee;
      const matchesPriority = filters.filterPriority === 'all' || (task.priority || 'None') === filters.filterPriority;
      const matchesTag = filters.filterTag === 'all' || Boolean(task.tags?.includes(filters.filterTag));

      if (filters.filterUnreadOnly) {
        const readIds = new Set(filters.readComments?.[task.id] ?? []);
        const hasUnreadComment = task.history?.some(
          (e) => e.type === 'comment' && e.id && !readIds.has(e.id)
        ) ?? false;
        const isWaitingInput = task.swimlane === 'require-input' || (filters.requireInputStatus
          ? task.status === filters.requireInputStatus
          : false);
        if (!hasUnreadComment && !isWaitingInput) return false;
      }

      return matchesQuery && matchesAssignee && matchesPriority && matchesTag;
    })
    .sort((left, right) => {
      switch (filters.sortOption) {
        case 'priority': {
          const priorityDiff = (priorityOrder.get(left.priority || 'None') ?? Number.MAX_SAFE_INTEGER)
            - (priorityOrder.get(right.priority || 'None') ?? Number.MAX_SAFE_INTEGER);
          return priorityDiff || getTaskActivityTimestamp(right) - getTaskActivityTimestamp(left) || left.id.localeCompare(right.id);
        }
        case 'assignee': {
          const assigneeDiff = (left.assignee || 'unassigned').localeCompare(right.assignee || 'unassigned');
          return assigneeDiff || getTaskActivityTimestamp(right) - getTaskActivityTimestamp(left) || left.id.localeCompare(right.id);
        }
        case 'updated':
        default:
          return getTaskActivityTimestamp(right) - getTaskActivityTimestamp(left) || left.id.localeCompare(right.id);
      }
    });
}

export function getTaskSearchScore(task: Task, query: string) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const fields = getTaskSearchableText(task);
  const combined = [fields.id, fields.title, fields.body, fields.tags, fields.assignee, fields.status]
    .filter(Boolean)
    .join(' ');
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  let score = 0;

  if (fields.id === normalizedQuery) {
    score += 900;
  } else if (fields.id.startsWith(normalizedQuery)) {
    score += 620;
  } else if (fields.id.includes(normalizedQuery)) {
    score += 360;
  }

  if (fields.title.startsWith(normalizedQuery)) {
    score += 320;
  } else if (fields.title.includes(normalizedQuery)) {
    score += 240;
  }

  if (fields.body.includes(normalizedQuery)) {
    score += 140;
  }

  if (fields.tags.includes(normalizedQuery)) {
    score += 90;
  }

  if (fields.assignee.includes(normalizedQuery) || fields.status.includes(normalizedQuery)) {
    score += 70;
  }

  if (tokens.length > 1 && tokens.every((token) => combined.includes(token))) {
    score += 220;
  }

  score += getSubsequenceScore(fields.id, normalizedQuery) * 5;
  score += getSubsequenceScore(fields.title, normalizedQuery) * 4;
  score += getSubsequenceScore(combined, normalizedQuery);

  return score;
}

export function searchTasks(tasks: Task[], query: string, limit = 8): TaskSearchResult[] {
  return tasks
    .map((task) => ({ task, score: getTaskSearchScore(task, query) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => {
      return right.score - left.score
        || getTaskActivityTimestamp(right.task) - getTaskActivityTimestamp(left.task)
        || left.task.id.localeCompare(right.task.id);
    })
    .slice(0, limit);
}