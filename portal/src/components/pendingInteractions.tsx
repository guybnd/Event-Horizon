import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAppActions, useAppSelector, shallowEqual } from '../store/useAppSelector';
import type { Task, CliSessionStatus } from '../types';
import {
  answerQuestion,
  fetchPendingApprovals,
  fetchPendingBoardRebases,
  fetchPendingQuestions,
  fetchTaskCliSession,
  BOARD_CONVERSATION_ID,
  type PendingApproval,
  type PendingBoardRebase,
  type PendingQuestion,
  type BoardRebaseFailure,
} from '../api';
import { ChatApprovalPanel } from './ApprovalPrompts';
import { ChatQuestionPicker } from './AskQuestionPrompts';
import { ChatBoardRebasePanel } from './BoardRebasePanel';

/**
 * FLUX-720 / FLUX-898: the data layer for every "the agent is waiting on you" prompt.
 *
 * EH has three kinds of pending interaction — gated tool approvals (`permission_prompt`,
 * FLUX-605), structured questions (`ask_user_question`, FLUX-662), and board-rebase batches
 * (`propose_board_rebase`, FLUX-659). Each used to subscribe to SSE independently and surface
 * inconsistently. This provider aggregates all three queues — keyed by `conversationId` — behind
 * one SSE subscription. It is purely a data layer: rendering lives in the inline chat panels
 * (`ChatPendingInteractions`) and the unified attention surface (`AttentionDock`, FLUX-898), both
 * of which read the same queues here. There is no longer a fallback overlay or pending-window
 * presentation state in this provider.
 *
 *  - `pendingPromptConversationIds` — the set of conversation ids with an unresolved prompt.
 *    The dock taskbar uses it to pin the originating chat's tab (hard-gated close + prompt
 *    icon) so a chat awaiting your answer can't be closed/lost.
 *  - `requireInputConversationIds` / `requireInputTickets` — tickets carrying the `require-input`
 *    swimlane, surfaced in the attention surface so a grooming "needs your input" lands in the
 *    same loud place as live prompts.
 */

export interface PendingInteractionsValue {
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  rebases: PendingBoardRebase[];
  /** FLUX-729: post-apply per-item failures, snapshotted so they outlive the resolved batch. */
  rebaseFailures: BoardRebaseFailure[];
  /** Non-null conversation ids that currently have at least one unresolved pending prompt. */
  pendingPromptConversationIds: Set<string>;
  /** FLUX-923: the single conversation with a live CLI session, when EXACTLY one exists; else null.
   *  Used as a resilience net so an UNROUTED prompt (`conversationId == null` — an engine routing
   *  miss, FLUX-908) is still claimed inline by the one unambiguous active chat instead of black-holing
   *  the inline surface. Null when zero or several sessions are live (ambiguous → leave it to the dock).
   *  The orchestrator (`__board__`) counts toward this — a live board makes a lone live ticket ambiguous
   *  (so a board question can't be mis-claimed by it), and is the sole claimant when only it is live. */
  singleActiveConversationId: string | null;
  /** Ticket ids with the require-input swimlane — for a persistent "needs input" badge on the chat tab. */
  requireInputConversationIds: Set<string>;
  /** Tickets currently carrying the `require-input` swimlane — surfaced in the same attention surface so a
   *  grooming "needs your input" lands in one loud place instead of only a quiet board-card flag. Derived
   *  client-side from the task store; no engine change. */
  requireInputTickets: Task[];
  removeApproval: (id: string) => void;
  removeQuestion: (id: string) => void;
  removeRebase: (id: string) => void;
  /** FLUX-729: record/clear a resolved batch's failed items. */
  reportRebaseFailure: (failure: BoardRebaseFailure) => void;
  dismissRebaseFailure: (batchId: string) => void;
}

const PendingInteractionsContext = createContext<PendingInteractionsValue | null>(null);

/** FLUX-923: CLI session statuses that mean "this chat could be the one currently awaiting you" — a
 *  session in any of these may have just parked an ask_user_question. Terminal states are excluded. */
const LIVE_SESSION_STATUSES: CliSessionStatus[] = ['pending', 'running', 'waiting-input'];

export function PendingInteractionsProvider({ children }: { children: ReactNode }) {
  const { subscribeToEvent } = useAppActions();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [rebases, setRebases] = useState<PendingBoardRebase[]>([]);
  // FLUX-729: failed items from resolved batches — kept here (not in the card) so they survive the
  // SSE drop of the pending batch and stay visible until the user dismisses them.
  const [rebaseFailures, setRebaseFailures] = useState<BoardRebaseFailure[]>([]);
  // FLUX-923: the orchestrator (`__board__`) session's status. The board is NOT a task in the store,
  // so its liveness would otherwise be invisible here — and an UNROUTED board question would then be
  // mis-claimed inline by a lone live ticket chat. We track it (SSE-driven, like ChatDock) purely to
  // fold board liveness into the `singleActiveConversationId` ambiguity test below.
  const [boardSessionStatus, setBoardSessionStatus] = useState<CliSessionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    // One catch-up fetch per queue picks up anything already parked (e.g. after a reload);
    // thereafter the engine pushes request/resolved over SSE — no polling (FLUX-611).
    void (async () => {
      try {
        const p = await fetchPendingApprovals();
        if (!cancelled) setApprovals(p);
      } catch {
        /* SSE will deliver */
      }
      try {
        const p = await fetchPendingQuestions();
        if (!cancelled) setQuestions(p);
      } catch {
        /* SSE will deliver */
      }
      try {
        const p = await fetchPendingBoardRebases();
        if (!cancelled) setRebases(p);
      } catch {
        /* SSE will deliver */
      }
    })();

    const addApproval = (d: unknown) => {
      const req = d as PendingApproval | null;
      if (!req || !req.id) return;
      setApprovals((prev) => (prev.some((p) => p.id === req.id) ? prev : [...prev, req]));
    };
    const addQuestion = (d: unknown) => {
      const req = d as PendingQuestion | null;
      if (!req || !req.id) return;
      setQuestions((prev) => (prev.some((p) => p.id === req.id) ? prev : [...prev, req]));
    };
    const addRebase = (d: unknown) => {
      const batch = d as PendingBoardRebase | null;
      if (!batch || !batch.id) return;
      setRebases((prev) => (prev.some((p) => p.id === batch.id) ? prev : [...prev, batch]));
    };
    const idOf = (d: unknown) => (d as { id?: string } | null)?.id;
    const dropApproval = (d: unknown) => {
      const id = idOf(d);
      if (id) setApprovals((prev) => prev.filter((p) => p.id !== id));
    };
    const dropQuestion = (d: unknown) => {
      const id = idOf(d);
      if (id) setQuestions((prev) => prev.filter((p) => p.id !== id));
    };
    const dropRebase = (d: unknown) => {
      const id = idOf(d);
      if (id) setRebases((prev) => prev.filter((p) => p.id !== id));
    };

    const unsubs = [
      subscribeToEvent('permission-request', addApproval),
      subscribeToEvent('permission-resolved', dropApproval),
      subscribeToEvent('ask-question', addQuestion),
      subscribeToEvent('ask-question-resolved', dropQuestion),
      subscribeToEvent('board-rebase-proposed', addRebase),
      subscribeToEvent('board-rebase-resolved', dropRebase),
    ];
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [subscribeToEvent]);

  // FLUX-923: track the orchestrator session's liveness. The board has no entry in the task store, so
  // (like ChatDock) we fetch its session once, then refetch only on a board event — the engine streams
  // `activity`/`taskUpdated` keyed `__board__`. No idle polling; this only needs to be roughly current
  // for the ambiguity test (a live board ⇒ the live-session count is ambiguous, never a lone ticket).
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await fetchTaskCliSession(BOARD_CONVERSATION_ID);
        if (!cancelled) setBoardSessionStatus(s?.status ?? null);
      } catch {
        /* transient — keep last good */
      }
    };
    void refresh();
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === BOARD_CONVERSATION_ID || o.id === BOARD_CONVERSATION_ID);
    };
    const on = (d: unknown) => { if (matches(d)) void refresh(); };
    const unsubs = [subscribeToEvent('activity', on), subscribeToEvent('taskUpdated', on)];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [subscribeToEvent]);

  // FLUX-923: a session is "live" (could be the one that just asked) while it is pending / running /
  // waiting on input. completed/failed/cancelled sessions are not candidates to own an unrouted prompt.
  const liveConversationIds = useAppSelector(
    (s) => s.tasks.filter((t) => t.cliSession && LIVE_SESSION_STATUSES.includes(t.cliSession.status)).map((t) => t.id),
    shallowEqual,
  );
  // The single unambiguous live chat, or null when none / several are live. An unrouted question is
  // attributed here so a routing miss still lands inline (the strict per-conversation match still wins
  // when a concrete conversationId is present). Multiple live sessions ⇒ ambiguous ⇒ dock-only.
  //
  // FLUX-923: the orchestrator (`__board__`) counts as a live session too. Folding it in closes the
  // board-liveness blind spot: with a live board + exactly one live ticket the count is 2 ⇒ ambiguous
  // ⇒ an unrouted (board) question stays dock-only instead of being mis-claimed by the lone ticket
  // chat. With ONLY the board live it is the sole claimant (`__board__`), so an unrouted board question
  // lands inline in the board chat — the correct surface.
  const boardLive = boardSessionStatus != null && LIVE_SESSION_STATUSES.includes(boardSessionStatus);
  const liveCount = liveConversationIds.length + (boardLive ? 1 : 0);
  const singleActiveConversationId =
    liveCount !== 1
      ? null
      : liveConversationIds.length === 1
        ? liveConversationIds[0]
        : BOARD_CONVERSATION_ID;

  // Tickets with the require-input swimlane, derived from the task store so a grooming "needs your
  // input" shows in the same attention surface (no engine change — the portal already has every ticket).
  const requireInputTickets = useAppSelector(
    (s) => s.tasks.filter((t) => t.swimlane === 'require-input'),
    shallowEqual,
  );

  const pendingPromptConversationIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of approvals) if (a.conversationId) set.add(a.conversationId);
    for (const q of questions) if (q.conversationId) set.add(q.conversationId);
    for (const r of rebases) if (r.conversationId) set.add(r.conversationId);
    return set;
  }, [approvals, questions, rebases]);

  // Ticket ids with the require-input swimlane — the dock taskbar uses this to put a PERSISTENT
  // "needs your input" badge on the chat's tab (like a parked prompt). Unlike the ack-clearable
  // needs-input session state, it stays until the swimlane is cleared (answered) and shows even
  // with no live session.
  const requireInputConversationIds = useMemo(
    () => new Set(requireInputTickets.map((t) => t.id)),
    [requireInputTickets],
  );

  const value = useMemo<PendingInteractionsValue>(
    () => ({
      requireInputTickets,
      approvals,
      questions,
      rebases,
      rebaseFailures,
      pendingPromptConversationIds,
      singleActiveConversationId,
      requireInputConversationIds,
      removeApproval: (id) => setApprovals((prev) => prev.filter((p) => p.id !== id)),
      removeQuestion: (id) => setQuestions((prev) => prev.filter((p) => p.id !== id)),
      removeRebase: (id) => setRebases((prev) => prev.filter((p) => p.id !== id)),
      reportRebaseFailure: (failure) =>
        setRebaseFailures((prev) =>
          prev.some((f) => f.batchId === failure.batchId) ? prev : [...prev, failure],
        ),
      dismissRebaseFailure: (batchId) =>
        setRebaseFailures((prev) => prev.filter((f) => f.batchId !== batchId)),
    }),
    [
      requireInputTickets,
      approvals,
      questions,
      rebases,
      rebaseFailures,
      pendingPromptConversationIds,
      singleActiveConversationId,
      requireInputConversationIds,
    ],
  );

  return (
    <PendingInteractionsContext.Provider value={value}>
      {children}
    </PendingInteractionsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- canonical context hook, colocated with its provider.
export function usePendingInteractions(): PendingInteractionsValue {
  const ctx = useContext(PendingInteractionsContext);
  if (!ctx) throw new Error('usePendingInteractions must be used within a PendingInteractionsProvider');
  return ctx;
}

/**
 * FLUX-923: composer-as-answer wiring for one chat, shared by the dock ChatWindow and the task-modal
 * ChatPane (previously copy-pasted in both — extracting it kills the drift risk). A single-question
 * `ask_user_question` parked for this conversation — its own id, or an unrouted prompt claimed by the
 * single live chat (see `singleActiveConversationId`) — can be answered straight from the composer.
 * Multi-question prompts return a null `answerPrompt` and keep to the picker chips (one free-text reply
 * can't be attributed to one of several questions).
 *
 * `onAnswerQuestion` deliberately does NOT swallow a failed POST: it lets the error propagate so the
 * composer can keep the user's typed text for a retry (the engine stays parked either way). The inline
 * picker remains mounted as the other answer path.
 */
// eslint-disable-next-line react-refresh/only-export-components -- composer wiring hook, colocated with the pending-interactions model it reads.
export function useComposerAnswer(conversationId: string): {
  answerPrompt: { id: string; label: string } | null;
  onAnswerQuestion: (text: string) => Promise<void>;
} {
  const { questions, singleActiveConversationId, removeQuestion } = usePendingInteractions();
  const pendingQuestion = useMemo(
    () =>
      questions.find(
        (p) =>
          p.conversationId === conversationId ||
          (p.conversationId == null && singleActiveConversationId === conversationId),
      ) ?? null,
    [questions, conversationId, singleActiveConversationId],
  );
  const answerPrompt = useMemo(
    () =>
      pendingQuestion && pendingQuestion.questions.length === 1
        ? { id: pendingQuestion.id, label: pendingQuestion.questions[0].header || pendingQuestion.questions[0].question }
        : null,
    [pendingQuestion],
  );
  const onAnswerQuestion = useCallback(
    async (text: string) => {
      if (!pendingQuestion || pendingQuestion.questions.length !== 1) return;
      const q = pendingQuestion.questions[0];
      // Let a failed POST throw — the composer keeps the typed text so it isn't lost. Only remove the
      // prompt once the engine accepted the answer (SSE ask-question-resolved also removes it; idempotent).
      await answerQuestion(pendingQuestion.id, { [q.question]: text.trim() });
      removeQuestion(pendingQuestion.id);
    },
    [pendingQuestion, removeQuestion],
  );
  return { answerPrompt, onAnswerQuestion };
}

/**
 * The unified inline prompt surface for one chat — mounted in a chat dock window and the task
 * modal's chat pane (the `questionPicker` slot of `ChatView`). Renders all three pending-prompt
 * types filtered to this `conversationId`. This is what makes every open chat a full prompt surface
 * for approvals, questions, and board-rebase batches alike. The same prompt also mirrors in the
 * unified attention surface (FLUX-898); resolution is single-flight via SSE, so there is no
 * double-submit even when both surfaces are mounted.
 */
export function ChatPendingInteractions({ conversationId }: { conversationId: string }) {
  return (
    <>
      <ChatApprovalPanel conversationId={conversationId} />
      <ChatBoardRebasePanel conversationId={conversationId} />
      <ChatQuestionPicker conversationId={conversationId} />
    </>
  );
}

/** The agent's question + the timestamp the require-input swimlane was set: the comment on the latest
 *  `swimlane_change → set require-input` entry (question falls back to the most recent comment). */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the require-input model; shared with the attention surface (FLUX-898).
export function requireInputMeta(task: Task): { question: string; setDate: string } {
  // FLUX-725: pre-computed on the list digest (the attention dock reads list tasks, which no longer
  // carry full history). Fall back to scanning `history` for a DETAIL task (modal/chat) without a digest.
  if (task.historyDigest) {
    return task.historyDigest.requireInput ?? { question: 'This ticket is waiting for your input.', setDate: '' };
  }
  const entries = task.history ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; action?: string; swimlane?: string; comment?: string; date?: string };
    if (e?.type === 'swimlane_change' && e.action === 'set' && e.swimlane === 'require-input') {
      return { question: e.comment || 'This ticket is waiting for your input.', setDate: e.date ?? '' };
    }
  }
  let question = 'This ticket is waiting for your input.';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; comment?: string };
    if (e?.type === 'comment' && e.comment) {
      question = e.comment;
      break;
    }
  }
  return { question, setDate: '' };
}
