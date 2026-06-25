import { useState } from 'react';
import { HelpCircle, Send, Plus } from 'lucide-react';
import { usePendingInteractions } from './pendingInteractions';
import { answerQuestion, type PendingQuestion, type AskQuestion } from '../api';

/**
 * FLUX-662 / FLUX-720: surfaces an agent's `ask_user_question` call as an interactive picker
 * and returns the user's selection into the same agent turn. The pending queue is owned by
 * `PendingInteractionsProvider` (one shared SSE subscription); this file renders the
 * inline-in-chat picker + the card. Unrouted/closed-chat questions fall through to the unified
 * global fallback (`PendingInteractionFallback`).
 */

/**
 * Inline picker for one chat pane — rendered inside ChatView (between transcript and
 * composer). Shows only this conversation's pending questions, keeping the picker attached
 * to the chat that asked.
 */
export function ChatQuestionPicker({ conversationId }: { conversationId: string }) {
  const { questions, removeQuestion } = usePendingInteractions();
  const mine = questions.filter((p) => p.conversationId === conversationId);
  if (mine.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {mine.map((p) => (
        <QuestionCard key={p.id} pending={p} onResolved={() => removeQuestion(p.id)} />
      ))}
    </div>
  );
}

/**
 * The picker itself — renders each question's options as single- or multi-select chips with
 * an "Other" free-text affordance (parity with the native AskUserQuestion), plus an optional
 * note. Submitting POSTs the selection to the engine, which settles the parked agent call.
 * `bare` drops the card chrome (used by callers that supply their own).
 */
export function QuestionCard({
  pending,
  onResolved,
  bare = false,
}: {
  pending: PendingQuestion;
  onResolved: () => void;
  bare?: boolean;
}) {
  const { questions } = pending;
  // Selections keyed by question index. For single-select we keep ≤1 entry; multi keeps many.
  const [choices, setChoices] = useState<Record<number, string[]>>({});
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleOption(qi: number, label: string, multi: boolean) {
    setChoices((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...prev, [qi]: next };
      }
      // single-select: picking a real option clears any "Other" entry.
      setOtherOn((o) => ({ ...o, [qi]: false }));
      return { ...prev, [qi]: [label] };
    });
  }

  function toggleOther(qi: number, multi: boolean) {
    setOtherOn((prev) => {
      const on = !prev[qi];
      // single-select: enabling Other clears the chosen option.
      if (on && !multi) setChoices((c) => ({ ...c, [qi]: [] }));
      return { ...prev, [qi]: on };
    });
  }

  function valueFor(qi: number, q: AskQuestion): string | string[] | undefined {
    const labels = [...(choices[qi] ?? [])];
    if (otherOn[qi] && otherText[qi]?.trim()) labels.push(otherText[qi].trim());
    if (labels.length === 0) return undefined;
    return q.multiSelect ? labels : labels[0];
  }

  // FLUX-664: UI selection state above (choices/otherOn/otherText) is keyed by question INDEX, so
  // two questions with identical `question` text never collide in the picker. The wire payload,
  // however, MUST stay keyed by question text: the engine's AnswerResult.answers is
  // Record<questionText, label(s)> and the ask_user_question MCP tool returns that object verbatim
  // to the agent (engine/src/ask-questions.ts, mcp-server.ts). Re-keying by index here would
  // require an engine + tool-contract change, which is out of scope. Residual constraint: if an
  // agent poses two questions with byte-identical text, the later answer overwrites the earlier on
  // the wire — that's an agent-authoring smell (give questions distinct text), not a picker bug.
  const answers: Record<string, string | string[]> = {};
  let complete = true;
  questions.forEach((q, qi) => {
    const v = valueFor(qi, q);
    if (v === undefined) complete = false;
    else answers[q.question] = v;
  });

  async function submit() {
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await answerQuestion(pending.id, answers, notes.trim() || undefined);
      // Remove only after the engine accepted the answer. (The engine also broadcasts
      // ask-question-resolved, which removes it via SSE too — idempotent.) Resolving up front
      // would strand the agent if the POST failed: the picker vanishes for this client but the
      // engine stays parked until timeout. (FLUX-662 review m1 / FLUX-664.)
      onResolved();
    } catch (err) {
      // POST failed (or the question is no longer pending) — keep the picker so the user can
      // retry, and surface the error. The engine is still parked until a successful answer.
      setError(err instanceof Error ? err.message : 'Failed to submit answer.');
      setSubmitting(false);
    }
  }

  return (
    <div className={bare ? '' : 'eh-border rounded-xl border border-primary/30 bg-primary/5 p-3'}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-primary">
        <HelpCircle className="h-3.5 w-3.5" /> The agent has a question
      </div>
      <div className="flex flex-col gap-3">
        {questions.map((q, qi) => (
          <div key={qi}>
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
              {q.header}
            </div>
            <div className="mb-1.5 text-[13px] text-[var(--eh-text-primary)]">{q.question}</div>
            <div className="flex flex-col gap-1.5">
              {q.options.map((opt, oi) => {
                const sel = (choices[qi] ?? []).includes(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => toggleOption(qi, opt.label, !!q.multiSelect)}
                    className={`flex w-full flex-col rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                      sel
                        ? 'border-primary bg-primary/15 text-[var(--eh-text-primary)]'
                        : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                  >
                    <span className="text-[12px] font-medium">{opt.label}</span>
                    {opt.description && (
                      <span className="text-[11px] text-[var(--eh-text-muted)]">{opt.description}</span>
                    )}
                  </button>
                );
              })}
              {/* "Other" free-text affordance — parity with the native picker. */}
              <button
                type="button"
                onClick={() => toggleOther(qi, !!q.multiSelect)}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors ${
                  otherOn[qi]
                    ? 'border-primary bg-primary/15 text-[var(--eh-text-primary)]'
                    : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <Plus className="h-3 w-3" /> Other…
              </button>
              {otherOn[qi] && (
                <input
                  type="text"
                  autoFocus
                  value={otherText[qi] ?? ''}
                  onChange={(e) => setOtherText((t) => ({ ...t, [qi]: e.target.value }))}
                  placeholder="Type your answer…"
                  className="eh-border w-full rounded-lg border bg-[var(--eh-input-bg)] px-2.5 py-1.5 text-[12px] text-[var(--eh-text-primary)] placeholder:text-[var(--eh-text-muted)] focus:border-primary focus:outline-none"
                />
              )}
            </div>
          </div>
        ))}
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add a note (optional)…"
          className="eh-border w-full rounded-lg border bg-[var(--eh-input-bg)] px-2.5 py-1.5 text-[12px] text-[var(--eh-text-primary)] placeholder:text-[var(--eh-text-muted)] focus:border-primary focus:outline-none"
        />
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-500">
            {error} — your selection was kept; please try again.
          </div>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!complete || submitting}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" /> {submitting ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </div>
  );
}
