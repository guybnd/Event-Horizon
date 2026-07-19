import { useState } from 'react';
import { HelpCircle, Send, Plus, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePendingInteractions } from './pendingInteractions';
import { answerQuestion, type PendingQuestion, type AskQuestion, type AskOption } from '../api';
import { TaskMarkdown } from './TaskMarkdown';

// FLUX-1409: heuristic flag for the agent's suggested pick — negation-aware so an option the
// agent explicitly steers the user AWAY from ("not recommended") is never highlighted as the
// good one. No wire/type change: this reads the same label/description text already rendered.
const REC_RE = /\brecommended\b/i;
const NOT_REC_RE = /\bnot\s+recommended\b/i;
function isRecommended(opt: AskOption): boolean {
  const text = `${opt.label} ${opt.description ?? ''}`;
  return REC_RE.test(text) && !NOT_REC_RE.test(text);
}

/**
 * FLUX-888: minimal inline markdown for the picker's clickable option chips. Every block-level
 * construct collapses to inline/fragment output so the markup stays valid *inside the option
 * `<button>`* (no `<p>`/`<div>` block children, no nested interactive `<a>`) and the button's own
 * click is never swallowed — links render as plain styled text rather than real anchors.
 */
function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
        code: ({ children }) => (
          <code className="rounded bg-black/10 px-1 py-0.5 text-[0.9em] dark:bg-white/10">{children}</code>
        ),
        ul: ({ children }) => <>{children}</>,
        ol: ({ children }) => <>{children}</>,
        li: ({ children }) => <>{children} </>,
        pre: ({ children }) => <>{children}</>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * FLUX-662 / FLUX-720: surfaces an agent's `ask_user_question` call as an interactive picker
 * and returns the user's selection into the same agent turn. The pending queue is owned by
 * `PendingInteractionsProvider` (one shared SSE subscription); this file renders the
 * inline-in-chat picker + the card. The same question also mirrors in the unified attention
 * surface (`AttentionDock`, FLUX-898), so a closed-chat question is never lost.
 */

/**
 * Inline picker for one chat pane — rendered inside ChatView (between transcript and
 * composer). Shows only this conversation's pending questions, keeping the picker attached
 * to the chat that asked.
 */
export function ChatQuestionPicker({ conversationId }: { conversationId: string }) {
  const { questions, removeQuestion, singleActiveConversationId } = usePendingInteractions();
  // Strict per-conversation match is the primary path. FLUX-923 resilience net: a question that
  // routed UNROUTED (`conversationId == null` — an engine binding/token miss, FLUX-908) would
  // otherwise match no chat and only ever show in the dock. When exactly one chat has a live session,
  // it is unambiguously the asker, so claim the unrouted prompt inline there instead of black-holing
  // the inline surface. Ambiguous (zero/several live) → singleActiveConversationId is null → no claim.
  const mine = questions.filter(
    (p) =>
      p.conversationId === conversationId ||
      (p.conversationId == null && singleActiveConversationId === conversationId),
  );
  if (mine.length === 0) return null;

  return (
    // FLUX-1413: `min-h-0 flex-1` so this root actually claims the bounded space ChatView's
    // wrapper (`flex min-h-0 shrink flex-col overflow-hidden`) offers it — without it, this div's
    // height is content-driven (`auto`), so the card's own `flex-1 min-h-0` below has no bounded
    // parent to resolve against and falls back to overflowing instead of scrolling in place.
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {mine.map((p) => (
        // FLUX-923: `eh-prompt-arrival` pulses the card on MOUNT (= a question arriving in this open
        // chat) then settles to a quiet ring. Keyed by `p.id` so a re-asked question remounts and the
        // pulse replays; a plain re-render does not restart it. Reduced-motion → static ring.
        // FLUX-1413: made a flex column (not a plain block box) so it passes the bounded height
        // down to `QuestionCard`. Multiple concurrent pending questions each get `flex-1`, splitting
        // the available space evenly rather than any one collapsing to zero.
        <div key={p.id} className="eh-prompt-arrival flex min-h-0 flex-1 flex-col">
          <QuestionCard pending={p} onResolved={() => removeQuestion(p.id)} scrollable />
        </div>
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
  scrollable = false,
}: {
  pending: PendingQuestion;
  onResolved: () => void;
  bare?: boolean;
  /**
   * FLUX-888: cap the questions/options region with a max-height + vertical resize so a long or
   * many-option question scrolls in place instead of overflowing the chat. Only the inline-in-chat
   * picker sets this — the fallback renders inside `FloatingPanel`, which already scrolls + resizes,
   * so leaving it false there avoids a nested second scrollbar. The Send button stays pinned below
   * the scroll region so it's always reachable.
   */
  scrollable?: boolean;
}) {
  const { questions } = pending;
  // Selections keyed by question index. For single-select we keep ≤1 entry; multi keeps many.
  const [choices, setChoices] = useState<Record<number, string[]>>({});
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // FLUX-1505: decision-collapse — the picker folds into a compact chosen-answer chip the instant
  // Send is clicked (no waiting on the POST), and springs back open on failure so the user can
  // retry with their selection intact. Network semantics are unchanged: `onResolved()` still only
  // fires after the engine accepts the answer (see `submit` below) — collapsing is purely visual.
  const [collapsed, setCollapsed] = useState(false);

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
    setCollapsed(true); // fold into the chosen-answer chip immediately — purely visual
    try {
      await answerQuestion(pending.id, answers, notes.trim() || undefined);
      // Remove only after the engine accepted the answer. (The engine also broadcasts
      // ask-question-resolved, which removes it via SSE too — idempotent.) Resolving up front
      // would strand the agent if the POST failed: the picker vanishes for this client but the
      // engine stays parked until timeout. (FLUX-662 review m1 / FLUX-664.)
      onResolved();
    } catch (err) {
      // POST failed (or the question is no longer pending) — spring back open so the user can
      // retry with their selection intact, and surface the error. The engine is still parked
      // until a successful answer.
      setError(err instanceof Error ? err.message : 'Failed to submit answer.');
      setSubmitting(false);
      setCollapsed(false);
    }
  }

  // FLUX-1505: a short human-readable summary of the chosen answer(s) for the collapsed chip.
  const chosenSummary = Object.values(answers).flat().join(', ');

  if (collapsed) {
    return (
      <div className={bare ? '' : 'eh-border rounded-xl border border-primary/30 bg-primary/5 p-3'}>
        <div className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[var(--eh-text-primary)] ${submitting ? 'animate-pulse' : ''}`}>
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <HelpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          <span className="min-w-0 flex-1 truncate">{chosenSummary || 'Answer sent'}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${bare ? '' : 'eh-border rounded-xl border border-primary/30 bg-primary/5 p-3'} ${
        scrollable ? 'flex min-h-0 flex-col' : ''
      }`}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-primary">
        <HelpCircle className="h-3.5 w-3.5" /> The agent has a question
      </div>
      <div className={`flex flex-col gap-3 ${scrollable ? 'min-h-0 flex-1' : ''}`}>
        <div
          className={
            // FLUX-1413: `flex-1 min-h-0` lets the region fill (and shrink within) a bounded
            // parent pane so the header/note/Send chrome below it never gets pushed off-screen —
            // that's the ChatView task-modal case. `max-h-[60vh]` is the fallback cap for mounts
            // with no definite parent height (AttentionDock tray, popovers), where flex-1 alone
            // wouldn't constrain anything.
            scrollable
              ? 'flex flex-1 min-h-0 max-h-[60vh] resize-y flex-col gap-3 overflow-y-auto pr-1'
              : 'flex flex-col gap-3'
          }
        >
        {questions.map((q, qi) => (
          <div key={qi}>
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
              {q.header}
            </div>
            <div className="mb-1.5 text-[13px] text-[var(--eh-text-primary)]">
              <TaskMarkdown body={q.question} compact imageMode="comment" />
            </div>
            <div className="flex flex-col gap-1.5">
              {q.options.map((opt, oi) => {
                const sel = (choices[qi] ?? []).includes(opt.label);
                const rec = isRecommended(opt);
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => toggleOption(qi, opt.label, !!q.multiSelect)}
                    className={`flex w-full flex-col rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                      sel
                        ? 'border-primary bg-primary/15 text-[var(--eh-text-primary)]'
                        : rec
                          ? 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)] ring-1 ring-primary/40 hover:bg-black/5 dark:hover:bg-white/5'
                          : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-1 text-[12px] font-medium">
                      <InlineMarkdown text={opt.label} />
                      {rec && (
                        <span className="rounded bg-primary/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                          Recommended
                        </span>
                      )}
                    </span>
                    {opt.description && (
                      <span className="text-[11px] text-[var(--eh-text-muted)]">
                        <InlineMarkdown text={opt.description} />
                      </span>
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
        </div>
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
