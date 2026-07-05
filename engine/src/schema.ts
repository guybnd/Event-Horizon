export type RelationType =
  | 'relates'
  | 'blocks'
  | 'blocked-by'
  | 'retries'
  | 'refactors'
  | 'refactored-by'
  | 'duplicates'
  | 'duplicated-by';

export const RELATION_TYPES = new Set<RelationType>([
  'relates',
  'blocks',
  'blocked-by',
  'retries',
  'refactors',
  'refactored-by',
  'duplicates',
  'duplicated-by',
]);

export const INVERSE_RELATION: Record<RelationType, RelationType> = {
  'relates': 'relates',
  'blocks': 'blocked-by',
  'blocked-by': 'blocks',
  'retries': 'retries',
  'refactors': 'refactored-by',
  'refactored-by': 'refactors',
  'duplicates': 'duplicated-by',
  'duplicated-by': 'duplicates',
};

// Terminal ticket statuses — a ticket in one of these has no live work a branch merge would
// silently sweep along (merge advances every ticket on the branch → Done). Single source of
// truth for the shared-PR merge guard (pr-tickets) and post-merge / reconcile cleanup
// (pr-cleanup), which previously each kept their own copy of this set (FLUX-650).
export const TERMINAL_TICKET_STATUSES: ReadonlySet<string> = new Set(['Done', 'Released', 'Archived']);

export interface TicketValidationError {
  path: string;
  message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ISO_DATE_RE.test(value) && !Number.isNaN(new Date(value).getTime());
}

export function validateHistoryEntry(entry: unknown, index: number): TicketValidationError[] {
  const errors: TicketValidationError[] = [];
  const at = `history[${index}]`;

  if (!entry || typeof entry !== 'object') {
    errors.push({ path: at, message: 'history entry must be an object' });
    return errors;
  }

  const e = entry as Record<string, unknown>;

  if (!isNonEmptyString(e.type)) {
    errors.push({ path: `${at}.type`, message: 'missing or empty type' });
    return errors;
  }

  if (!isNonEmptyString(e.user)) {
    errors.push({ path: `${at}.user`, message: 'missing or empty user' });
  }

  if (!isIsoDate(e.date)) {
    errors.push({ path: `${at}.date`, message: 'missing or invalid ISO date' });
  }

  switch (e.type) {
    case 'activity':
    case 'comment':
    case 'agent_message':
      if (!isNonEmptyString(e.comment)) {
        errors.push({ path: `${at}.comment`, message: `${e.type} entry requires a non-empty comment` });
      }
      break;
    case 'status_change':
      if (!isNonEmptyString(e.from)) {
        errors.push({ path: `${at}.from`, message: "status_change requires 'from' (not 'oldStatus')" });
      }
      if (!isNonEmptyString(e.to)) {
        errors.push({ path: `${at}.to`, message: "status_change requires 'to' (not 'newStatus')" });
      }
      break;
    case 'agent_session':
      if (!isNonEmptyString(e.sessionId)) {
        errors.push({ path: `${at}.sessionId`, message: 'agent_session requires sessionId' });
      }
      if (!isIsoDate(e.startedAt)) {
        errors.push({ path: `${at}.startedAt`, message: 'agent_session requires ISO startedAt' });
      }
      if (!isNonEmptyString(e.status)) {
        errors.push({ path: `${at}.status`, message: 'agent_session requires status' });
      }
      break;
    case 'swimlane_change':
      if (!isNonEmptyString(e.swimlane)) {
        errors.push({ path: `${at}.swimlane`, message: 'swimlane_change requires swimlane id' });
      }
      if (e.action !== 'set' && e.action !== 'cleared') {
        errors.push({ path: `${at}.action`, message: "swimlane_change requires action 'set' or 'cleared'" });
      }
      break;
    default:
      errors.push({ path: `${at}.type`, message: `unknown history entry type '${e.type}'` });
  }

  return errors;
}

export function validateSubtasks(subtasks: unknown): TicketValidationError[] {
  if (subtasks == null) return [];
  if (!Array.isArray(subtasks)) {
    return [{ path: 'subtasks', message: 'subtasks must be an array' }];
  }
  const errors: TicketValidationError[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    const entry: unknown = subtasks[i];
    const at = `subtasks[${i}]`;
    if (typeof entry === 'string') {
      if (!entry.trim()) errors.push({ path: at, message: 'empty subtask id' });
      continue;
    }
    if (entry && typeof entry === 'object') {
      if (!isNonEmptyString((entry as Record<string, unknown>).id)) {
        errors.push({ path: at, message: 'inline subtask object missing id field — will be silently dropped on load' });
      }
      continue;
    }
    errors.push({ path: at, message: `subtask must be a string id or object with id, got ${typeof entry}` });
  }
  return errors;
}

export function validateLinks(links: unknown): TicketValidationError[] {
  if (links == null) return [];
  if (!Array.isArray(links)) {
    return [{ path: 'links', message: 'links must be an array' }];
  }
  const errors: TicketValidationError[] = [];
  for (let i = 0; i < links.length; i++) {
    const entry: unknown = links[i];
    const at = `links[${i}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push({ path: at, message: `link must be an object, got ${typeof entry}` });
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.type) || !RELATION_TYPES.has(e.type as RelationType)) {
      errors.push({ path: `${at}.type`, message: `link type must be one of: ${[...RELATION_TYPES].join(', ')}` });
    }
    if (!isNonEmptyString(e.target)) {
      errors.push({ path: `${at}.target`, message: 'link target must be a non-empty string' });
    }
    if (e.label != null && typeof e.label !== 'string') {
      errors.push({ path: `${at}.label`, message: 'link label must be a string when present' });
    }
  }
  return errors;
}

export function validateTicketFrontmatter(fm: unknown): TicketValidationError[] {
  const errors: TicketValidationError[] = [];

  if (!fm || typeof fm !== 'object') {
    return [{ path: '', message: 'frontmatter must be an object' }];
  }

  const f = fm as Record<string, unknown>;

  if (!isNonEmptyString(f.title)) {
    errors.push({ path: 'title', message: 'missing or empty title' });
  }
  if (!isNonEmptyString(f.status)) {
    errors.push({ path: 'status', message: 'missing or empty status' });
  }

  // FLUX-657: a tombstone pointer on a merged-away source ticket (set by the `merge` verb) —
  // the survivor ticket id this card was folded into. Optional; a non-empty string when present.
  if (f.mergedInto != null && !isNonEmptyString(f.mergedInto)) {
    errors.push({ path: 'mergedInto', message: 'mergedInto must be a non-empty string when present' });
  }

  if (f.tags != null) {
    if (!Array.isArray(f.tags)) {
      errors.push({ path: 'tags', message: 'tags must be an array' });
    } else {
      f.tags.forEach((t: unknown, i: number) => {
        if (typeof t !== 'string') errors.push({ path: `tags[${i}]`, message: 'tag must be a string' });
      });
    }
  }

  if (f.history != null) {
    if (!Array.isArray(f.history)) {
      errors.push({ path: 'history', message: 'history must be an array' });
    } else {
      f.history.forEach((entry: unknown, i: number) => {
        errors.push(...validateHistoryEntry(entry, i));
      });
    }
  }

  errors.push(...validateSubtasks(f.subtasks));
  errors.push(...validateLinks(f.links));

  return errors;
}

export function formatValidationErrors(errors: TicketValidationError[]): string {
  return errors.map((e) => `  - ${e.path || '(root)'}: ${e.message}`).join('\n');
}
