// FLUX-643: parse one-tap reply chips from a Require-Input question. Kept in its own
// (component-free) module so the chat-context component file stays Fast-Refresh-clean.

import type { Task, HistoryEntry } from '../../types';
import { isAgentSession } from '../../types';
import type { QuickReply } from './ChatView';

const MAX_QUICK_REPLIES = 4;

// FLUX-649: obvious decline/destructive choices (skip / no / cancel / none / …) get tagged
// `danger` so they render red in the chip row — the choice reads as destructive before tap.
const DECLINE_RE = /^(skip|no|cancel|none|decline|abort|don'?t)\b/i;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** Pull the latest agent question text from the ticket history (the comment / session that
 *  asked for input). */
function latestQuestionText(task: Task): string | null {
  const history: HistoryEntry[] = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (isAgentSession(entry)) {
      const text = entry.finalMessage?.trim() || entry.comment?.trim();
      if (text) return text;
      continue;
    }
    if (entry.type === 'comment' && entry.comment?.trim()) return entry.comment.trim();
  }
  return null;
}

/**
 * Parse one-tap reply chips from a Require-Input question. Conservative on purpose — only
 * fires when the text reads like it's soliciting a choice (has a question mark) and enumerates
 * ≥2 short options as a bullet/numbered list. Anything else returns [] so the chat falls back
 * to the free-text composer.
 */
export function parseQuickReplies(task: Task, requireInputStatus: string): QuickReply[] {
  if (task.status !== requireInputStatus) return [];
  const text = latestQuestionText(task);
  if (!text || !text.includes('?')) return [];

  const options: QuickReply[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const m = rawLine.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!m) continue;
    // Strip light markdown emphasis and trailing punctuation for a clean label.
    const label = m[1]!.replace(/[*_`]/g, '').replace(/[.;,]\s*$/, '').trim();
    // Skip lines too long to be a discrete choice, or duplicates.
    if (!label || label.length > 60 || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    options.push({ label: truncate(label, 40), value: label, tone: DECLINE_RE.test(label) ? 'danger' : undefined });
    if (options.length >= MAX_QUICK_REPLIES) break;
  }

  return options.length >= 2 ? options : [];
}
