import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, ExternalLink, HelpCircle, X } from 'lucide-react';
import { useAppActions, useTaskById, useAppSelector, shallowEqual } from '../store/useAppSelector';
import type { Task } from '../types';
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
  /** Ticket ids with the require-input swimlane — for a persistent "needs input" badge on the chat tab. */
  requireInputConversationIds: Set<string>;
  /** Tickets currently carrying the `require-input` swimlane — surfaced in the same pending bar so a
   *  grooming "needs your input" lands in one loud place (the pinned tab count) instead of only a
   *  quiet board-card flag. Derived client-side from the task store; no engine change. */
  requireInputTickets: Task[];
  /** Hide a require-input ticket from the pending bar (persisted; the ticket keeps its board swimlane). */
  dismissRequireInput: (task: Task) => void;
  /** FLUX-809: total count of pending prompts (approvals + questions + rebases + post-apply failures)
   *  PLUS require-input tickets, claimed-or-not — the always-meaningful number on the pinned Pending tab. */
  pendingCount: number;
  /** FLUX-809: whether the user has manually opened the pending fallback window via the Pending
   *  tab. Orphan prompts still force the window visible regardless (the FLUX-720 safety); this only
   *  adds a manual open/close on top of that. */
  pendingPanelOpen: boolean;
  /** FLUX-813: effective visibility of the pending fallback window — `hasOrphans || pendingPanelOpen`.
   *  Orphan prompts force the window open even when the user hasn't clicked the Pending tab, so the
   *  tab's open-indicator must reflect this derived value, not the manual `pendingPanelOpen` alone. */
  pendingPanelVisible: boolean;
  /** FLUX-809: bumped each time the Pending tab is clicked, so the (possibly already-mounted)
   *  window re-clamps itself back on-screen. */
  revealNonce: number;
  /** FLUX-809: toggle the manual-open state (and request a re-clamp). When orphans exist the
   *  window can't actually hide, so this degrades to a "bring it back on-screen" action. */
  togglePendingPanel: () => void;
  /** FLUX-809: explicitly close the manually-opened window (the window's own ✕, only offered when
   *  there are no orphan prompts left to force it open). */
  closePendingPanel: () => void;
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
  // FLUX-809: manual open state for the pending fallback window (driven by the pinned Pending tab).
  // Orphans still force the window open independently; this only adds a user-driven open/close.
  const [pendingPanelOpen, setPendingPanelOpen] = useState(false);
  const [revealNonce, setRevealNonce] = useState(0);

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

  const togglePendingPanel = useCallback(() => {
    setPendingPanelOpen((v) => !v);
    setRevealNonce((n) => n + 1);
  }, []);
  const closePendingPanel = useCallback(() => setPendingPanelOpen(false), []);

  // Tickets with the require-input swimlane, derived from the task store so a grooming "needs your
  // input" shows in the same pending bar (no engine change — the portal already has every ticket).
  const allRequireInputTickets = useAppSelector(
    (s) => s.tasks.filter((t) => t.swimlane === 'require-input'),
    shallowEqual,
  );
  // Per-item dismiss: hide a require-input from the bar WITHOUT touching the ticket's board swimlane
  // (the persistent record stays on the card). Persisted by id+set-date so a NEW question re-surfaces.
  const [dismissedRequireInput, setDismissedRequireInput] = useState<Set<string>>(loadDismissedRequireInput);
  const requireInputTickets = useMemo(
    () => allRequireInputTickets.filter((t) => !dismissedRequireInput.has(requireInputKey(t))),
    [allRequireInputTickets, dismissedRequireInput],
  );
  const dismissRequireInput = useCallback((task: Task) => {
    setDismissedRequireInput((prev) => {
      const key = requireInputKey(task);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      saveDismissedRequireInput(next);
      return next;
    });
  }, []);

  // FLUX-809: total pending prompts across all queues + require-input tickets — the count shown on the
  // pinned Pending tab (loud amber + pulse when > 0), so grooming questions are no longer easy to miss.
  const pendingCount =
    approvals.length + questions.length + rebases.length + rebaseFailures.length + requireInputTickets.length;

  // Auto-pop the pending window whenever the pending set GROWS — a new approval/question/rebase or a
  // newly-raised require-input pops it on-screen instead of only bumping the tab badge. Rising-edge
  // only, so closing the window (✕) or dismissing an item never re-opens it; the next NEW item does.
  // require-input isn't in `pendingPanelVisible`'s force-open set, so the ✕ can still hide it.
  const prevPendingCountRef = useRef(0);
  useEffect(() => {
    if (pendingCount > prevPendingCountRef.current) {
      setPendingPanelOpen(true);
      setRevealNonce((n) => n + 1);
    }
    prevPendingCountRef.current = pendingCount;
  }, [pendingCount]);

  // FLUX-813: do any pending prompts lack an inline surface? Orphans force the fallback window open
  // (the FLUX-720 safety) — the same predicate the fallback uses to gate itself, hoisted here so the
  // Pending tab can derive its effective visibility. `pendingPanelVisible` = orphan-forced OR manual.
  const hasOrphans = useMemo(() => {
    const anyOrphan = (items: { conversationId: string | null }[]) =>
      items.some((p) => !isClaimed(p.conversationId));
    return (
      anyOrphan(approvals) || anyOrphan(questions) || anyOrphan(rebases) || anyOrphan(rebaseFailures)
    );
  }, [approvals, questions, rebases, rebaseFailures, isClaimed]);
  const pendingPanelVisible = hasOrphans || pendingPanelOpen;

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
  // with no live session. Dismissed items are excluded, so a bar dismiss clears the tab flag too.
  const requireInputConversationIds = useMemo(
    () => new Set(requireInputTickets.map((t) => t.id)),
    [requireInputTickets],
  );

  const value = useMemo<PendingInteractionsValue>(
    () => ({
      requireInputTickets,
      dismissRequireInput,
      approvals,
      questions,
      rebases,
      rebaseFailures,
      pendingPromptConversationIds,
      requireInputConversationIds,
      pendingCount,
      pendingPanelOpen,
      pendingPanelVisible,
      revealNonce,
      togglePendingPanel,
      closePendingPanel,
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
    [
      requireInputTickets,
      dismissRequireInput,
      approvals,
      questions,
      rebases,
      rebaseFailures,
      pendingPromptConversationIds,
      requireInputConversationIds,
      pendingCount,
      pendingPanelOpen,
      pendingPanelVisible,
      revealNonce,
      togglePendingPanel,
      closePendingPanel,
      claim,
      release,
      isClaimed,
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
    pendingPromptConversationIds,
    pendingPanelOpen,
    revealNonce,
    closePendingPanel,
    removeApproval,
    removeQuestion,
    removeRebase,
    reportRebaseFailure,
    dismissRebaseFailure,
    requireInputTickets,
    dismissRequireInput,
  } = usePendingInteractions();
  const { openChat } = useDockActions();

  // Jumping to a chat from the pending window should close the window, not draw on top of the ticket
  // you just opened (require-input isn't force-open, so this hides it).
  const jumpToChat = useCallback(
    (id: string) => {
      openChat(id);
      closePendingPanel();
    },
    [openChat, closePendingPanel],
  );

  const orphanApprovals = approvals.filter((p) => !isClaimed(p.conversationId));
  const orphanQuestions = questions.filter((p) => !isClaimed(p.conversationId));
  const orphanRebases = rebases.filter((p) => !isClaimed(p.conversationId));
  const orphanFailures = rebaseFailures.filter((f) => !isClaimed(f.conversationId));

  const hasOrphans = !!(
    orphanApprovals.length ||
    orphanQuestions.length ||
    orphanRebases.length ||
    orphanFailures.length
  );

  // FLUX-809: orphan prompts always force the window open (the FLUX-720 no-orphans safety). The
  // pinned Pending tab can additionally open it manually even when every prompt is being handled
  // inline — but it can never hide a window that still has orphan prompts to resolve.
  if (!hasOrphans && !pendingPanelOpen) return null;

  // Chats whose pending prompt is handled inline (claimed) — offered as jump chips when the user
  // opens the window manually with no orphans of its own to resolve, so the count is never a dead end.
  const claimedPendingIds = [...pendingPromptConversationIds].filter((id) => isClaimed(id));

  const count =
    orphanApprovals.length + orphanRebases.length + orphanQuestions.length + orphanFailures.length;
  // Include require-input tickets in the window's title count + attention pulse so the surface
  // reflects everything waiting on you, not just the parked prompts.
  const totalCount = count + requireInputTickets.length;

  return (
    <FloatingPanel
      storageKey="eh.pendingFallback.geometry.v2"
      title={totalCount > 0 ? `Pending · ${totalCount} item${totalCount === 1 ? '' : 's'}` : 'Pending'}
      defaultWidth={600}
      defaultHeight={690}
      tone="attention"
      pulse={hasOrphans || requireInputTickets.length > 0}
      revealSignal={revealNonce}
      // The close ✕ hides the window; it stays gated while orphan prompts force it open (resolve them
      // in-place to dismiss — the FLUX-720 no-ignore safety). Minimize was removed: the ✕ is the single
      // expected hide control, and require-input items can be dismissed individually instead.
      onClose={hasOrphans ? undefined : closePendingPanel}
    >
      <div className="flex flex-col gap-2">
        {orphanApprovals.map((p) => (
          <FallbackItem
            key={p.id}
            conversationId={p.conversationId}
            summary={`Tool approval · ${p.toolName}`}
            onOpen={openChat}
          >
            <ApprovalCard pending={p} onResolved={() => removeApproval(p.id)} />
          </FallbackItem>
        ))}
        {orphanRebases.map((p) => (
          <FallbackItem
            key={p.id}
            conversationId={p.conversationId}
            summary={`Board rebase · ${p.items.length} item${p.items.length === 1 ? '' : 's'}`}
            onOpen={openChat}
          >
            <RebaseCard
              batch={p}
              onResolved={() => removeRebase(p.id)}
              onFailures={reportRebaseFailure}
            />
          </FallbackItem>
        ))}
        {orphanFailures.map((f) => (
          <FallbackItem
            key={`fail-${f.batchId}`}
            conversationId={f.conversationId}
            summary={`Rebase failures · ${f.failed.length} item${f.failed.length === 1 ? '' : 's'}`}
            onOpen={openChat}
          >
            <RebaseFailureCard failure={f} onDismiss={() => dismissRebaseFailure(f.batchId)} />
          </FallbackItem>
        ))}
        {orphanQuestions.map((p) => (
          <FallbackItem
            key={p.id}
            conversationId={p.conversationId}
            summary={`Question · ${p.questions[0]?.header || p.questions[0]?.question || 'Awaiting your answer'}`}
            onOpen={openChat}
          >
            <QuestionCard pending={p} onResolved={() => removeQuestion(p.id)} />
          </FallbackItem>
        ))}
        {/* Grooming "Require Input" tickets — surfaced here as jump-to-answer items so a board-card
            swimlane is no longer the only signal that the agent is blocked on you. */}
        {requireInputTickets.map((t) => (
          <RequireInputItem key={`ri-${t.id}`} task={t} onOpen={jumpToChat} onDismiss={dismissRequireInput} />
        ))}
        {/* FLUX-813: jump chips for prompts handled inline in their own chat. Rendered below the
            orphan items REGARDLESS of `hasOrphans` so the window always accounts for the full
            pending count (orphan + claimed) — never a "tab says 3, window shows 2" dead end. */}
        {claimedPendingIds.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--eh-border)] bg-black/[0.02] p-2.5 dark:bg-white/[0.02]">
            <div className="text-[11px] font-medium text-[var(--eh-text-muted)]">
              These chats have a prompt open in their own window:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {claimedPendingIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => openChat(id)}
                  title="Open this chat"
                  className="flex items-center gap-1 rounded-lg border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-400/20 dark:text-amber-300"
                >
                  <ExternalLink className="h-3 w-3" />
                  {id === BOARD_CONVERSATION_ID ? 'Board chat' : id}
                </button>
              ))}
            </div>
          </div>
        )}
        {!hasOrphans && claimedPendingIds.length === 0 && requireInputTickets.length === 0 && (
          <div className="px-1 py-6 text-center text-xs text-[var(--eh-text-muted)]">
            No pending items — you’re all caught up.
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}

/**
 * A fallback card wrapper: a header row with the origin chip (links to the originating dock) and a
 * collapse toggle, above the prompt card. The chip shows the owning ticket (`id · title`) so a queue
 * of items is identifiable at a glance; collapsing replaces the card body with the one-line `summary`
 * so several queued prompts stay scannable. Default state is expanded — an orphan prompt is never
 * hidden by default; collapse is a manual, per-item affordance.
 */
function FallbackItem({
  conversationId,
  summary,
  onOpen,
  children,
}: {
  conversationId: string | null;
  summary: string;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // conversationId is the originating ticket id for ticket chats — resolve it to a title via the
  // store (skipping the board chat and null/legacy ids). Falls back to the raw id if no task matches,
  // so a non-ticket conversationId never renders blank or crashes the lookup.
  const task = useTaskById(
    conversationId && conversationId !== BOARD_CONVERSATION_ID ? conversationId : undefined,
  );
  const originLabel =
    conversationId == null
      ? 'Unrouted'
      : conversationId === BOARD_CONVERSATION_ID
        ? 'Board chat'
        : task?.title
          ? `${conversationId} · ${task.title}`
          : conversationId;

  return (
    <div className="eh-surface eh-border flex flex-col gap-1.5 rounded-xl border p-2 shadow-2xl">
      <div className="flex items-center justify-between gap-2">
        {conversationId ? (
          <button
            type="button"
            onClick={() => onOpen(conversationId)}
            title="Open this chat"
            className="flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)] transition-colors hover:text-primary"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">{originLabel}</span>
          </button>
        ) : (
          <div className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
            {originLabel}
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          className="shrink-0 rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Expand"
          className="truncate text-left text-xs text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-primary)]"
        >
          {summary}
        </button>
      ) : (
        children
      )}
    </div>
  );
}

const DISMISSED_RI_KEY = 'eh-dismissed-require-input';
const DISMISSED_RI_CAP = 200;

/** The agent's question + the timestamp the require-input swimlane was set: the comment on the latest
 *  `swimlane_change → set require-input` entry (question falls back to the most recent comment). */
function requireInputMeta(task: Task): { question: string; setDate: string } {
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

/** Stable per-ticket dismissal key — id + the swimlane-set timestamp, so a FRESH require-input on the
 *  same ticket (a new question after the last was answered) re-surfaces instead of staying dismissed. */
function requireInputKey(task: Task): string {
  return `${task.id}:${requireInputMeta(task).setDate}`;
}

function loadDismissedRequireInput(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_RI_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDismissedRequireInput(set: Set<string>): void {
  try {
    // Cap to avoid unbounded growth as tickets churn (keys for cleared tickets linger harmlessly).
    localStorage.setItem(DISMISSED_RI_KEY, JSON.stringify([...set].slice(-DISMISSED_RI_CAP)));
  } catch {
    /* storage full/disabled — dismissal is a nicety, not load-bearing */
  }
}

/**
 * A require-input ticket rendered as a pending-bar item. Unlike a parked approval/question, a
 * grooming "Require Input" carries free-form prose (proposed options, not a structured picker), so
 * the affordance is "Open to answer" — it pops the ticket chat where you reply. This is what unifies
 * grooming questions into the same loud surface as approvals/questions instead of a quiet board-card
 * swimlane the user has to happen to notice.
 */
function RequireInputItem({
  task,
  onOpen,
  onDismiss,
}: {
  task: Task;
  onOpen: (id: string) => void;
  onDismiss: (task: Task) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const question = requireInputMeta(task).question;
  const clipped = question.length > 280 ? `${question.slice(0, 280).trimEnd()}…` : question;
  const label = task.title ? `${task.id} · ${task.title}` : task.id;

  return (
    <div className="eh-surface eh-border flex flex-col gap-1.5 rounded-xl border p-2 shadow-2xl">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          <HelpCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">Needs your input · {label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed}
            className="shrink-0 rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => onDismiss(task)}
            title="Dismiss from this list (the ticket keeps its require-input flag on the board)"
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--eh-text-secondary)]">
            {clipped}
          </div>
          <button
            type="button"
            onClick={() => onOpen(task.id)}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-hover"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open to answer
          </button>
        </>
      )}
    </div>
  );
}
