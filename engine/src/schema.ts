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

export function validateHistoryEntry(entry: any, index: number): TicketValidationError[] {
  const errors: TicketValidationError[] = [];
  const at = `history[${index}]`;

  if (!entry || typeof entry !== 'object') {
    errors.push({ path: at, message: 'history entry must be an object' });
    return errors;
  }

  if (!isNonEmptyString(entry.type)) {
    errors.push({ path: `${at}.type`, message: 'missing or empty type' });
    return errors;
  }

  if (!isNonEmptyString(entry.user)) {
    errors.push({ path: `${at}.user`, message: 'missing or empty user' });
  }

  if (!isIsoDate(entry.date)) {
    errors.push({ path: `${at}.date`, message: 'missing or invalid ISO date' });
  }

  switch (entry.type) {
    case 'activity':
    case 'comment':
    case 'agent_message':
      if (!isNonEmptyString(entry.comment)) {
        errors.push({ path: `${at}.comment`, message: `${entry.type} entry requires a non-empty comment` });
      }
      break;
    case 'status_change':
      if (!isNonEmptyString(entry.from)) {
        errors.push({ path: `${at}.from`, message: "status_change requires 'from' (not 'oldStatus')" });
      }
      if (!isNonEmptyString(entry.to)) {
        errors.push({ path: `${at}.to`, message: "status_change requires 'to' (not 'newStatus')" });
      }
      break;
    case 'agent_session':
      if (!isNonEmptyString(entry.sessionId)) {
        errors.push({ path: `${at}.sessionId`, message: 'agent_session requires sessionId' });
      }
      if (!isIsoDate(entry.startedAt)) {
        errors.push({ path: `${at}.startedAt`, message: 'agent_session requires ISO startedAt' });
      }
      if (!isNonEmptyString(entry.status)) {
        errors.push({ path: `${at}.status`, message: 'agent_session requires status' });
      }
      break;
    case 'swimlane_change':
      if (!isNonEmptyString(entry.swimlane)) {
        errors.push({ path: `${at}.swimlane`, message: 'swimlane_change requires swimlane id' });
      }
      if (entry.action !== 'set' && entry.action !== 'cleared') {
        errors.push({ path: `${at}.action`, message: "swimlane_change requires action 'set' or 'cleared'" });
      }
      break;
    default:
      errors.push({ path: `${at}.type`, message: `unknown history entry type '${entry.type}'` });
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
    const entry = subtasks[i];
    const at = `subtasks[${i}]`;
    if (typeof entry === 'string') {
      if (!entry.trim()) errors.push({ path: at, message: 'empty subtask id' });
      continue;
    }
    if (entry && typeof entry === 'object') {
      if (!isNonEmptyString((entry as any).id)) {
        errors.push({ path: at, message: 'inline subtask object missing id field — will be silently dropped on load' });
      }
      continue;
    }
    errors.push({ path: at, message: `subtask must be a string id or object with id, got ${typeof entry}` });
  }
  return errors;
}

export function validateTicketFrontmatter(fm: any): TicketValidationError[] {
  const errors: TicketValidationError[] = [];

  if (!fm || typeof fm !== 'object') {
    return [{ path: '', message: 'frontmatter must be an object' }];
  }

  if (!isNonEmptyString(fm.title)) {
    errors.push({ path: 'title', message: 'missing or empty title' });
  }
  if (fm.status != null && !isNonEmptyString(fm.status)) {
    errors.push({ path: 'status', message: 'status must be a non-empty string when present' });
  }

  if (fm.tags != null) {
    if (!Array.isArray(fm.tags)) {
      errors.push({ path: 'tags', message: 'tags must be an array' });
    } else {
      fm.tags.forEach((t: any, i: number) => {
        if (typeof t !== 'string') errors.push({ path: `tags[${i}]`, message: 'tag must be a string' });
      });
    }
  }

  if (fm.history != null) {
    if (!Array.isArray(fm.history)) {
      errors.push({ path: 'history', message: 'history must be an array' });
    } else {
      fm.history.forEach((entry: any, i: number) => {
        errors.push(...validateHistoryEntry(entry, i));
      });
    }
  }

  errors.push(...validateSubtasks(fm.subtasks));

  return errors;
}

export function formatValidationErrors(errors: TicketValidationError[]): string {
  return errors.map((e) => `  - ${e.path || '(root)'}: ${e.message}`).join('\n');
}
