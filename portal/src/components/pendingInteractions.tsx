import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppActions } from '../store/useAppSelector';
import { useDockActions } from './DockProvider';
import {
  BOARD_CONVERSATION_ID,
  fetchPendingApprovals,
  fetchPendingBoardRebases,
  fetchPendingQuestions,
  type PendingApproval,
  type PendingBoardRebase,
  type PendingQuestion,
  type BoardRebaseFailure,
} from '../api';
import { ChatApprovalPanel, ApprovalCard } from './ApprovalPrompts';
import { ChatQuestionPicker, QuestionCard } from './AskQuestionPrompts';
import { ChatBoardRebasePanel, RebaseCard, RebaseFailureCard } from './BoardRebasePanel';
import { FloatingPanel } from './FloatingPanel';

/**
 * FLUX-720: one shared source of truth for every "the agent is waiting on you" prompt.
 *
 * EH has three kinds of pending interaction — gated tool approvals (`permission_prompt`,
 * FLUX-605), structured questions (`ask_user_question`, FLUX-662), and board-rebase batches
 * (`propose_board_rebase`, FLUX-659). They used to each subscribe to SSE independently and
 * surface inconsistently (a detached approval overlay, an orchestrator-only rebase panel).
 * This provider aggregates all three queues — keyed by `conversationId` — behind one SSE
 * subscription, so both the inline-in-chat panels and the taskbar gate read the same data:
 *
 *  - `pendingPromptConversationIds` — the set of conversation ids with an unresolved prompt.
 *    The dock taskbar uses it to pin the originating chat's tab (hard-gated close + prompt
 *    icon) so a chat awaiting your answer can't be closed/lost.
 *  - `claim` / `release` — an inline prompt surface (a `ChatPendingInteractions` mounted in a
 *    chat dock/modal) claims its conversation while mounted, so the global fallback overlay
 *    defers to the inline rendering and a prompt never double-renders (inline XOR fallback).
 */

export interface PendingInteractionsValue {
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  rebases: PendingBoardRebase[];
  /** FLUX-729: post-apply per-item failures, snapshotted so they outlive the resolved batch. */
  rebaseFailures: BoardRebaseFailure[];
  /** Non-null conversation ids that currently have at least one unresolved pending prompt. */
  pendingPromptConversationIds: Set<string>;
  removeApproval: (id: string) => void;
  removeQuestion: (id: string) => void;
  removeRebase: (id: string) => void;
  /** FLUX-729: record/clear a resolved batch's failed items. */
  reportRebaseFailure: (failure: BoardRebaseFailure) => void;
  dismissRebaseFailure: (batchId: string) => void;
  /** Claim/release a conversation while an inline prompt surface is mounted for it, so the
   *  global fallback defers to the inline rendering (refcounted — a conversation may be open
   *  in both the dock and the task modal at once). */
  claim: (conversationId: string) => void;
  release: (conversationId: string) => void;
  isClaimed: (conversationId: string | null) => boolean;
}

const PendingInteractionsContext = createContext<PendingInteractionsValue | null>(null);

export function PendingInteractionsProvider({ children }: { children: ReactNode }) {
  const { subscribeToEvent } = useAppActions();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [rebases, setRebases] = useState<PendingBoardRebase[]>([]);
  // FLUX-729: failed items from resolved batches — kept here (not in the card) so they survive the
  // SSE drop of the pending batch and stay visible until the user dismisses them.
  const [rebaseFailures, setRebaseFailures] = useState<BoardRebaseFailure[]>([]);
  // conversationId → mounted inline-surface count (refcounted claims).
  const [claimed, setClaimed] = useState<Record<string, number>>({});

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

  const claim = useCallback((id: string) => {
    setClaimed((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);
  const release = useCallback((id: string) => {
    setClaimed((prev) => {
      const n = (prev[id] ?? 0) - 1;
      const next = { ...prev };
      if (n <= 0) delete next[id];
      else next[id] = n;
      return next;
    });
  }, []);
  const isClaimed = useCallback(
    (id: string | null) => id != null && (claimed[id] ?? 0) > 0,
    [claimed],
  );

  const pendingPromptConversationIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of approvals) if (a.conversationId) set.add(a.conversationId);
    for (const q of questions) if (q.conversationId) set.add(q.conversationId);
    for (const r of rebases) if (r.conversationId) set.add(r.conversationId);
    return set;
  }, [approvals, questions, rebases]);

  const value = useMemo<PendingInteractionsValue>(
    () => ({
      approvals,
      questions,
      rebases,
      rebaseFailures,
      pendingPromptConversationIds,
      removeApproval: (id) => setApprovals((prev) => prev.filter((p) => p.id !== id)),
      removeQuestion: (id) => setQuestions((prev) => prev.filter((p) => p.id !== id)),
      removeRebase: (id) => setRebases((prev) => prev.filter((p) => p.id !== id)),
      reportRebaseFailure: (failure) =>
        setRebaseFailures((prev) =>
          prev.some((f) => f.batchId === failure.batchId) ? prev : [...prev, failure],
        ),
      dismissRebaseFailure: (batchId) =>
        setRebaseFailures((prev) => prev.filter((f) => f.batchId !== batchId)),
      claim,
      release,
      isClaimed,
    }),
    [approvals, questions, rebases, rebaseFailures, pendingPromptConversationIds, claim, release, isClaimed],
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
 * The unified inline prompt surface for one chat — mounted in a chat dock window and the task
 * modal's chat pane (the `questionPicker` slot of `ChatView`). Renders all three pending-prompt
 * types filtered to this `conversationId`, and claims the conversation while mounted so the
 * global fallback defers to it. This is what makes every open chat a full prompt surface for
 * approvals, questions, and board-rebase batches alike.
 */
export function ChatPendingInteractions({ conversationId }: { conversationId: string }) {
  const { claim, release } = usePendingInteractions();
  useEffect(() => {
    claim(conversationId);
    return () => release(conversationId);
  }, [conversationId, claim, release]);

  return (
    <>
      <ChatApprovalPanel conversationId={conversationId} />
      <ChatBoardRebasePanel conversationId={conversationId} />
      <ChatQuestionPicker conversationId={conversationId} />
    </>
  );
}

/**
 * Global fallback overlay (bottom-right) — the no-orphans guarantee. Renders any pending prompt
 * whose originating chat has no inline surface mounted (its dock isn't open) or whose
 * `conversationId` is null/legacy. Deduped against the inline panels via `isClaimed`, so a
 * prompt shows inline when its dock is open and here only when it isn't (inline XOR fallback).
 * Each card carries an "open chat" affordance that pops the originating dock so the user can
 * jump to the full conversation; the resolve controls themselves are always usable here too.
 */
export function PendingInteractionFallback() {
  const {
    approvals,
    questions,
    rebases,
    rebaseFailures,
    isClaimed,
    removeApproval,
    removeQuestion,
    removeRebase,
    reportRebaseFailure,
    dismissRebaseFailure,
  } = usePendingInteractions();
  const { openChat } = useDockActions();

  const orphanApprovals = approvals.filter((p) => !isClaimed(p.conversationId));
  const orphanQuestions = questions.filter((p) => !isClaimed(p.conversationId));
  const orphanRebases = rebases.filter((p) => !isClaimed(p.conversationId));
  const orphanFailures = rebaseFailures.filter((f) => !isClaimed(f.conversationId));

  if (
    !orphanApprovals.length &&
    !orphanQuestions.length &&
    !orphanRebases.length &&
    !orphanFailures.length
  )
    return null;

  const count =
    orphanApprovals.length + orphanRebases.length + orphanQuestions.length + orphanFailures.length;

  return (
    <FloatingPanel
      storageKey="eh.pendingFallback.geometry"
      title={`Pending · ${count} item${count === 1 ? '' : 's'}`}
      defaultWidth={400}
      defaultHeight={460}
    >
      <div className="flex flex-col gap-2">
        {orphanApprovals.map((p) => (
          <FallbackItem key={p.id} conversationId={p.conversationId} onOpen={openChat}>
            <ApprovalCard pending={p} onResolved={() => removeApproval(p.id)} />
          </FallbackItem>
        ))}
        {orphanRebases.map((p) => (
          <FallbackItem key={p.id} conversationId={p.conversationId} onOpen={openChat}>
            <RebaseCard
              batch={p}
              onResolved={() => removeRebase(p.id)}
              onFailures={reportRebaseFailure}
            />
          </FallbackItem>
        ))}
        {orphanFailures.map((f) => (
          <FallbackItem key={`fail-${f.batchId}`} conversationId={f.conversationId} onOpen={openChat}>
            <RebaseFailureCard failure={f} onDismiss={() => dismissRebaseFailure(f.batchId)} />
          </FallbackItem>
        ))}
        {orphanQuestions.map((p) => (
          <FallbackItem key={p.id} conversationId={p.conversationId} onOpen={openChat}>
            <QuestionCard pending={p} onResolved={() => removeQuestion(p.id)} />
          </FallbackItem>
        ))}
      </div>
    </FloatingPanel>
  );
}

/** A fallback card wrapper: an origin chip (links to the originating dock) above the prompt card. */
function FallbackItem({
  conversationId,
  onOpen,
  children,
}: {
  conversationId: string | null;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="eh-surface eh-border flex flex-col gap-1.5 rounded-xl border p-2 shadow-2xl">
      {conversationId ? (
        <button
          type="button"
          onClick={() => onOpen(conversationId)}
          title="Open this chat"
          className="flex items-center gap-1 self-start text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-primary"
        >
          <ExternalLink className="h-3 w-3" />
          {conversationId === BOARD_CONVERSATION_ID ? 'Board chat' : conversationId}
        </button>
      ) : (
        <div className="self-start text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
          Unrouted
        </div>
      )}
      {children}
    </div>
  );
}
