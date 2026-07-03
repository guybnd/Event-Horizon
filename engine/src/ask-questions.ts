import { parkPrompt, resolvePrompt, listOpenPrompts, QUESTION_TIMEOUT_MS, type QuestionPayload } from './hitl-prompts.js';

/**
 * FLUX-662: human-in-the-loop structured questions for chat/board sessions. The agent
 * calls the `ask_user_question` MCP tool (the working substitute for the native
 * AskUserQuestion, which can't be fulfilled in `claude -p` print mode — see the ticket's
 * step-1 spike). That tool POSTs to /api/board/ask-question, which parks until the user
 * answers via the portal picker; `resolveAnswer` settles the parked Promise so the tool result
 * (the selection) flows back into the SAME agent turn. The only semantic difference from a
 * permission prompt is the payload — chosen option label(s) + an optional note, not allow/deny.
 *
 * FLUX-833: this module is now a thin wrapper over the unified, restart-durable HITL store in
 * hitl-prompts.ts (shared with permission-prompts.ts). A pending question survives an engine
 * restart (re-surfaces in the portal with its original id) and the resolve path is idempotent.
 *
 * Timeout is deliberately long (questions are deliberative): on timeout the core resolves with a
 * clean `unanswered` sentinel the tool turns into "proceed using your best judgment" rather than
 * crashing the turn. It MUST stay safely under undici's 300s default `headersTimeout`: the
 * `ask_user_question` MCP tool holds a single `fetch` open with no bytes sent until we resolve, so
 * a timeout ≥300s would have undici abort the call client-side (UND_ERR_HEADERS_TIMEOUT) while the
 * question stayed parked — the agent would abandon the turn yet a late answer would still try to
 * write a phantom transcript entry (now guarded by the core's terminal-state check). 240s keeps the
 * park reachable end-to-end (FLUX-662 review M1). Going past 300s would require a custom undici
 * dispatcher on the fetch, not just a bigger number here (the gated Phase 4).
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

const ASK_TIMEOUT_MS = QUESTION_TIMEOUT_MS;

export function requestAnswer(
  questions: AskQuestion[],
  conversationId: string | null,
  resumeSessionId?: string,
): Promise<AnswerResult> {
  const payload: QuestionPayload = { questions };
  return parkPrompt({ kind: 'question', payload, conversationId, resumeSessionId, timeoutMs: ASK_TIMEOUT_MS }) as Promise<AnswerResult>;
}

export function resolveAnswer(id: string, result: AnswerResult): boolean {
  return resolvePrompt(id, result);
}

export function listPendingQuestions() {
  return listOpenPrompts('question').map((r) => {
    const p = r.payload as QuestionPayload;
    return { id: r.id, questions: p.questions as AskQuestion[], conversationId: r.conversationId, createdAt: r.createdAt };
  });
}
