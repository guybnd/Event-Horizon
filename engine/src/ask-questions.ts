import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';
import { appendTranscriptEvent } from './transcript.js';
import { raiseNeedsAction } from './parked-ticket.js';

/**
 * FLUX-662: human-in-the-loop structured questions for chat/board sessions. The agent
 * calls the `ask_user_question` MCP tool (the working substitute for the native
 * AskUserQuestion, which can't be fulfilled in `claude -p` print mode — see the ticket's
 * step-1 spike). That tool POSTs to /api/board/ask-question, which parks here and broadcasts
 * `ask-question`; the portal renders an interactive picker, the user selects, and
 * `resolveAnswer` settles the parked Promise so the tool result (the selection) flows back
 * into the SAME agent turn. Mirrors permission-prompts.ts; the only semantic difference is
 * the payload — chosen option label(s) + an optional note, not allow/deny.
 *
 * Timeout is deliberately long (questions are deliberative): on timeout we resolve with a
 * clean `unanswered` sentinel the tool turns into "proceed using your best judgment" rather
 * than crashing the turn.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AnswerResult {
  /** Keyed by question text → chosen label (single-select) or labels (multi-select). */
  answers: Record<string, string | string[]>;
  /** Optional free-text note the user added alongside their selection. */
  notes?: string;
  /** Set when the question timed out with no answer — the agent handles this gracefully. */
  unanswered?: boolean;
}

interface Pending {
  id: string;
  questions: AskQuestion[];
  conversationId: string | null;
  createdAt: string;
  resolve: (a: AnswerResult) => void;
}

const pending = new Map<string, Pending>();
// 4 minutes — questions are deliberative, so longer than the 120s snap allow/deny of a
// permission, but it MUST stay safely under undici's 300s default `headersTimeout`: the
// `ask_user_question` MCP tool holds a single `fetch` to /api/board/ask-question open with no
// bytes sent until we resolve, so a timeout ≥300s would have undici abort the call client-side
// (UND_ERR_HEADERS_TIMEOUT) while the question stayed parked here — the agent would abandon the
// turn yet a late answer would still write a phantom transcript entry. 240s keeps the park
// reachable end-to-end (FLUX-662 review M1). Going past 300s would require a custom undici
// dispatcher on the fetch, not just a bigger number here.
const ASK_TIMEOUT_MS = 240_000;

export function requestAnswer(questions: AskQuestion[], conversationId: string | null): Promise<AnswerResult> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  // Durable transcript (FLUX-662 step 7): record that a question was asked so a cold resume
  // can see the round-trip. Only for a real conversation (null → unrouted, no transcript).
  if (conversationId) {
    appendTranscriptEvent(conversationId, { type: 'ask-question', id, questions, timestamp: createdAt });
  }
  return new Promise<AnswerResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      broadcastEvent('ask-question-resolved', { id });
      const result: AnswerResult = { answers: {}, unanswered: true };
      if (conversationId) {
        appendTranscriptEvent(conversationId, { type: 'ask-answer', id, ...result, timestamp: new Date().toISOString() });
        // FLUX-826 (lever A): the live picker was never answered. Without a safety net the tool
        // just returns `unanswered → proceed with best judgment` and the question evaporates —
        // fatal on a resting/terminal ticket the user isn't watching. The conversationId is the
        // ticket id for per-ticket sessions, so raise the persistent needsAction flag +
        // notification on it. No-op for the `__board__` sentinel / unrouted ids (raiseNeedsAction
        // guards on a real ticket), and best-effort so a failure never blocks resolving the turn.
        void raiseNeedsAction(
          conversationId,
          'Agent asked a question that timed out unanswered — re-open the ticket to respond, or it will proceed on its best judgment.',
        );
      }
      resolve(result);
    }, ASK_TIMEOUT_MS);
    pending.set(id, {
      id, questions, conversationId, createdAt,
      resolve: (a) => { clearTimeout(timer); pending.delete(id); resolve(a); },
    });
    broadcastEvent('ask-question', { id, questions, conversationId, createdAt });
  });
}

export function resolveAnswer(id: string, result: AnswerResult): boolean {
  const p = pending.get(id);
  if (!p) return false;
  if (p.conversationId) {
    appendTranscriptEvent(p.conversationId, { type: 'ask-answer', id, ...result, timestamp: new Date().toISOString() });
  }
  p.resolve(result);
  broadcastEvent('ask-question-resolved', { id });
  return true;
}

export function listPendingQuestions() {
  return Array.from(pending.values()).map((p) => ({
    id: p.id, questions: p.questions, conversationId: p.conversationId, createdAt: p.createdAt,
  }));
}
