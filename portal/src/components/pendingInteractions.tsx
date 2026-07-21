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
import { BellRing, ChevronDown, ChevronUp, ClipboardCheck, ClipboardX, ExternalLink, Check, Loader2, Play, Undo2, X } from 'lucide-react';
import { useAppActions, useAppSelector, useTaskById, shallowEqual } from '../store/useAppSelector';
import type { Task, CliSessionStatus, GateValue, Config } from '../types';
import {
  answerQuestion,
  createBranch,
  fetchPendingApprovals,
  fetchPendingBoardRebases,
  fetchPendingQuestions,
  fetchTaskCliSession,
  startPlanRevise,
  updateTask,
  BOARD_CONVERSATION_ID,
  type PendingApproval,
  type PendingBoardRebase,
  type PendingQuestion,
  type BoardRebaseFailure,
} from '../api';
import { launchPhaseDefault } from '../agentActions';
import { isActiveSession } from '../orchestration';
import { resolveEffectiveAgent, frameworkSupports } from '../utils';
import { buildStatusChangeHistory, statusAfterGrooming } from '../lib/ticketActions';
import { useDockActions } from './DockProvider';
import { ChatApprovalPanel } from './ApprovalPrompts';
import { ChatQuestionPicker } from './AskQuestionPrompts';
import { ChatBoardRebasePanel } from './BoardRebasePanel';
import { Button } from './ui/Button';
import { useNotify, type NotifyApi } from '../hooks/useNotify';

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
 *
 * FLUX-1262 (gate-policy epic FLUX-1247) extends this aggregation with two more reasons — same
 * surface, no second inbox (see `AttentionDock`'s `plan-approval`/`gate-parked` item kinds):
 *  - `planApprovalTickets` — a `plan` gate ran a review pass (auto-driven or, under `you`, a manual
 *    `start_plan_review` — FLUX-1296) and is waiting for a human to confirm (`planReviewState` set,
 *    still in `Grooming`), regardless of which gate value produced it.
 *  - `gateParkedTickets` — a ticket the Furnace/Temper machinery parked (raised `require-input`)
 *    while driving a gate's `auto` loop, e.g. retryCap exhaustion — split out of the plain
 *    `requireInputTickets` bucket so a stalled auto-loop doesn't read as an ordinary question.
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
   *  client-side from the task store; no engine change. FLUX-1262: EXCLUDES gate-parked tickets (see
   *  `gateParkedTickets`) so a stalled auto-loop isn't double-counted as a plain question. */
  requireInputTickets: Task[];
  /** FLUX-1262: a `plan` gate review pass ran (any gate value — FLUX-1296) and the ticket is sitting
   *  in `Grooming` with `planReviewState` set awaiting a human confirm. Derived client-side (task store +
   *  board config); no engine change in this ticket — `planReviewState` is written by the "Plan-review
   *  runner" (FLUX-1263). */
  planApprovalTickets: Task[];
  /** FLUX-1262: tickets carrying `require-input` because Furnace/Temper parked them mid gate-`auto` loop
   *  (e.g. retryCap exhaustion) rather than a human-facing question — split out of `requireInputTickets`
   *  so the attention surface can give it the distinct ⛔ "gate-parked" treatment. */
  gateParkedTickets: Task[];
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

/** FLUX-1262: Furnace/Temper's `parkTicketOnBoard` (engine `furnace-stoker.ts`) is the only path that
 *  raises `require-input` from machine code, and it always posts a comment with this fixed prefix.
 *  That's the one signal available today to tell a stalled gate-`auto` loop apart from a genuine
 *  human-facing question — both land on the same swimlane, and per the epic's decision #8 a gate
 *  runner reuses this existing plumbing rather than adding a dedicated field for it. */
const FURNACE_PARK_MARKER = 'Parked by the Furnace:';

/** A `require-input` ticket that a gate's `auto` loop parked itself (e.g. retryCap exhaustion),
 *  rather than a human-facing question an agent raised. See {@link FURNACE_PARK_MARKER}. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the require-input model it extends (FLUX-1262); shared with the attention surface.
export function isGateParkedTicket(task: Task): boolean {
  return task.swimlane === 'require-input' && requireInputMeta(task).question.startsWith(FURNACE_PARK_MARKER);
}

/** Resolve a ticket's effective `plan` gate value: its own override, else the board default, else the
 *  hard-coded safe default — mirrors the engine's `resolveGateValue` (`models/gate-policy.ts`), which
 *  the portal can't import directly (separate package, see FLUX-1261's duplicated GateName/GateValue).
 *  Exported for `PlanApprovalPanel` (FLUX-1296), which needs to tell a `you`-gate ticket apart to
 *  offer its manual "Start plan review" trigger — the one case where nothing reviews it on its own. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1262); shared with PlanApprovalPanel (FLUX-1296).
export function resolvePlanGateValue(task: Task, config: Config | null | undefined): GateValue {
  return task.gatePolicyOverride?.plan ?? config?.gatePolicy?.boardDefault?.plan ?? 'you';
}

/** A ticket with a plan-review verdict awaiting a human's confirm — `planReviewState` set, ticket
 *  still in `Grooming` (see `Task.planReviewState`). FLUX-1296: gate-VALUE-agnostic — originally
 *  restricted to `auto-then-you` (the only mode wired to the loop-driver at the time), but the
 *  `you` gate's manual `start_plan_review` pass (FLUX-1263) lands in the exact same shape (a verdict
 *  sitting in `Grooming`) and deserves the exact same treatment: the reviewer's feedback and the
 *  Approve/Send-back/Set-aside actions, not just the passive board-card chip. `auto` never leaves a
 *  verdict sitting here unattended (it loops or parks automatically — see `gate-runner.ts`), so
 *  widening this to ALL gate values costs nothing there and fixes it for `you`, the system default.
 *  `config` is kept for signature stability (call sites already thread it through) even though it's
 *  no longer read here. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1262); shared with the attention surface.
export function isPlanApprovalPending(task: Task, _config: Config | null | undefined): boolean {
  return task.status === 'Grooming' && task.planReviewState != null;
}

/** FLUX-1339: the STANDING "Approve → Todo" gate — decoupled from `planReviewState`. A user who
 *  iterates on the plan conversationally in chat (no fresh re-review) clears the verdict, yet should
 *  still be able to approve; and even before any review a written plan is approvable. So the only
 *  requirements are: the ticket is in Grooming and has a non-empty plan body. The verdict, when one
 *  exists, is advisory (an emphasis/badge), never a gate on whether Approve can be clicked. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1339); shared with PlanApprovalPanel.
export function canApprovePlan(task: Task): boolean {
  return task.status === 'Grooming' && !!(task.body && task.body.trim());
}

/** FLUX-1319: the gate loop is ACTIVELY revising toward a verdict — `planGateRunning` AND the current
 *  verdict is `changes-requested` (mid review→revise→re-review). Crucially an `approved` verdict is
 *  NOT "revising": the loop has finished and only its cleanup lingers (`planGateRunning` stays true
 *  until the next gate tick calls `stopGateRun`), so an approved plan is immediately actionable. All
 *  surfaces gate their "Revising…" display — and the Needs-You inbox its exclusion — on THIS, not on
 *  raw `planGateRunning`; otherwise an approved-but-not-yet-cleaned-up plan shows "approved" AND
 *  "Revising…" at once with the confirm button suppressed (the reported bug). */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1319); shared across surfaces.
export function isPlanGateRevising(task: Task): boolean {
  return !!task.planGateRunning && task.planReviewState === 'changes-requested';
}

/** FLUX-1585: does a mid-gate user message (annotation reply, plain chat) belong to the plan-gate's
 *  revise flow instead of whatever ordinary chat session the ticket's `cliSession` happens to point
 *  at? True for an ACTIVE run (`planGateRunning`) AND for a PARKED wedge — the verdict is still
 *  `changes-requested` in Grooming even after `stopGateRun` tore down the run's registry entry (see
 *  the engine's `sweepParkedGateWedges`, `gate-runner.ts`). Broader than `isPlanGateRevising` (which
 *  requires BOTH flags together): a parked wedge has `planGateRunning` cleared, so that check alone
 *  would miss it. Chat/annotation composers gate their resume preference on this — never resuming a
 *  `phase:'review'` session while it's true — because `isLiveInputTarget`'s session-lifecycle signal
 *  has no way to know a review-phase session should never absorb this input while the gate owns the
 *  ticket (the FLUX-1560 incident this fixes: a resumed reviewer session folded in the user's
 *  annotations itself instead of the dispatched revise session doing it). */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1585); shared with ChatDock's send/enqueue/routeToChat.
export function isPlanGateInFlight(task: Task): boolean {
  return task.status === 'Grooming' && (!!task.planGateRunning || task.planReviewState === 'changes-requested');
}

/** FLUX-1319: does this plan-approval ticket belong in the blocking "Needs You" inbox RIGHT NOW?
 *  Only when a verdict is pending AND the gate loop is NOT actively revising it (see
 *  `isPlanGateRevising`). While the auto-loop revises/re-reviews a changes-requested plan the human
 *  is not needed; but an APPROVED plan awaiting confirm belongs here even if `planGateRunning` is
 *  briefly still true during cleanup. Distinct from `isPlanApprovalPending` (used by the in-chat card
 *  / plan panel), which still reflects the in-flight "Revising…" state on those within-ticket
 *  surfaces via the same `isPlanGateRevising` gate. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1319); shared with the attention surface.
export function isPlanApprovalNeedsYou(task: Task, config: Config | null | undefined): boolean {
  return isPlanApprovalPending(task, config) && !isPlanGateRevising(task);
}

/** FLUX-1289: the plan-review gate's latest feedback comment, for inline display on a
 *  `changes-requested` verdict. Mirrors `requireInputMeta`'s dual-path pattern in this same file:
 *  the pre-computed digest field for list-sourced surfaces (AttentionDock, ChatPlanApprovalCard),
 *  falling back to scanning full `history` for a DETAIL task (PlanApprovalPanel via
 *  `useTicketSideView`, which has no digest). Same "most recent comment" heuristic as
 *  `computeRequireInputMeta`'s fallback — true for both the human send-back path and the
 *  auto-review agent's own comment, which always precedes the `change_status` call recording it. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1289); shared with the attention surface.
export function planReviewFeedback(task: Task): { text: string; date: string; user?: string } | null {
  if (task.historyDigest) return task.historyDigest.planReviewComment ?? null;
  const entries = task.history ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; comment?: string; date?: string; user?: string };
    if (e?.type === 'comment' && e.comment) {
      return { text: e.comment, date: e.date ?? '', ...(e.user ? { user: e.user } : {}) };
    }
  }
  return null;
}

/** FLUX-1303: ONE attribution rule for plan-review feedback, shared by `PlanReviewFeedbackBlock`
 *  and `PlanApprovalPanel`'s verdict strip — the reviewer-sentinel author names live here and
 *  nowhere else, so the panel and the cards can never attribute the same comment differently. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1303); shared with the attention surface.
export function feedbackAuthorLabel(who: string | undefined, currentUser: string): string {
  if (who && who === currentUser) return 'You';
  if (!who || who === 'Agent' || who === 'Plan Gate' || who === 'Furnace' || who === 'Temper') return '🤖 Reviewer';
  return who;
}

/** FLUX-1303: the plan's own TL;DR line (the grooming convention's leading `> **TL;DR** — …`
 *  blockquote), so the compact cards can show WHAT the feedback is about without opening the plan. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with the pending-interactions model it feeds (FLUX-1303); shared with the attention surface.
export function planTldr(body: string | undefined | null): string | null {
  if (!body) return null;
  const m = body.match(/^>\s*(?:\*\*)?TL;?DR(?:\*\*)?\s*[—:–-]?\s*(.+)$/im);
  const text = m?.[1]?.replace(/\*\*|`/g, '').trim();
  if (!text) return null;
  return text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text;
}

/**
 * FLUX-1303: "Send for re-grooming" — THE primary action on a pending plan verdict, used by
 * `PlanReviewActions` (so both the AttentionDock tray item and `ChatPlanApprovalCard` share it).
 * `PlanApprovalPanel` calls `startPlanRevise` (the underlying `api.ts` function) directly instead —
 * see its own module doc — but ends up at the exact same one atomic engine call (`POST
 * /plan-review/revise`): records the user's notes as an attributed comment, stamps the
 * changes-requested verdict + reviewed-body hash, dispatches the grooming revise session, and
 * registers it with the plan-gate runner so the revision is automatically re-reviewed. Replaces
 * FLUX-1289's two-step `revisePlan` (dispatch, then a follow-up PUT to clear the verdict) whose
 * second call could fail silently and strand a stale card.
 */
// eslint-disable-next-line react-refresh/only-export-components -- action helper colocated with the pending-interactions model it operates on (FLUX-1303); shared with the AttentionDock/chat-card surfaces via PlanReviewActions.
export async function revisePlan(taskId: string, currentUser: string, notes?: string): Promise<void> {
  await startPlanRevise(taskId, { ...(notes?.trim() ? { notes: notes.trim() } : {}), user: currentUser });
}

/** FLUX-1303/FLUX-1369: the one "Approve → Todo" update shape — status + verdict clear + history —
 *  shared by `approvePlanToTodo` and `approvePlanAndStart` so the two can never drift on what
 *  "approved" actually writes. */
function buildPlanApprovalUpdate(task: Task, config: Config | null | undefined, currentUser: string) {
  const todoStatus = statusAfterGrooming((config?.columns ?? []).map((s) => s.name));
  return {
    status: todoStatus,
    appendHistory: buildStatusChangeHistory(task, todoStatus, currentUser),
    planReviewState: null,
    planReviewBodyHash: null,
    updatedBy: currentUser,
  };
}

/**
 * FLUX-1303: shared "Approve → Todo" for a pending plan verdict (quick Approve on an `approved`
 * verdict; the explicit "Approve anyway" override on `changes-requested`). Clears the verdict and
 * its reviewed-body hash in the same write; history travels as an `appendHistory` delta (never a
 * rebuilt full array — the stale-snapshot loss class from FLUX-1301).
 */
// eslint-disable-next-line react-refresh/only-export-components -- action helper colocated with the pending-interactions model it operates on (FLUX-1303); shared across the dock/chat-card surfaces.
export async function approvePlanToTodo(task: Task, config: Config | null | undefined, currentUser: string): Promise<void> {
  await updateTask(task.id, buildPlanApprovalUpdate(task, config, currentUser));
}

/**
 * FLUX-1294/FLUX-1369: the post-approval half of "Approve & start" — create a branch/worktree
 * (skipped for `XS` effort, per `config.worktreeByDefault`), then launch the default implementation
 * session, guarded against double-starting when a session is already active. `updated` is the
 * ALREADY-approved task (the caller's own commit already landed it in Todo) — this never touches
 * ticket status itself, only what happens after.
 *
 * Extracted from `PlanApprovalPanel`'s original `handleApproveAndStart` (FLUX-1294) so every
 * plan-review surface — the panel, the in-chat card, the "Needs You" dock prompt — shares this exact
 * dispatch instead of three copies drifting apart (the panel had it, the other two didn't, which is
 * the gap FLUX-1369 closes). This is deliberately a SEPARATE step from the approve commit: once that
 * commit succeeds the ticket IS correctly in Todo, so a dispatch failure here must never look like
 * the approval itself failed — it surfaces via `notify.error`/`notify.info` instead of whatever
 * inline error state the caller uses for its own commit step.
 */
// eslint-disable-next-line react-refresh/only-export-components -- action helper colocated with the pending-interactions model it operates on (FLUX-1369); shared across the dock/chat-card/panel surfaces.
export async function dispatchApprovedImplementation(
  updated: Task,
  config: Config | null | undefined,
  currentUser: string,
  notify: NotifyApi,
  focusComment?: string,
): Promise<void> {
  if (updated.cliSession && isActiveSession(updated.cliSession)) {
    notify.info(`${updated.id} approved, but a session is already running on it — no new session was started.`);
    return;
  }

  try {
    if (updated.effort !== 'XS') {
      await createBranch(updated.id, { worktree: !!config?.worktreeByDefault });
    }
    const framework = resolveEffectiveAgent(undefined, config?.defaultFramework);
    const result = await launchPhaseDefault({
      taskId: updated.id,
      framework,
      phase: 'implementation',
      currentUser,
      phaseDefaults: config?.phaseDefaults,
      supervisorCapable: frameworkSupports(config, framework, 'supervisor'),
      focusComment: focusComment ?? 'Plan approved via "Approve & start."',
    });
    if (!result) {
      notify.info(`${updated.id} approved, but no default implementation persona is configured — start it manually.`);
    }
  } catch (err) {
    notify.error(`${updated.id} approved, but couldn't auto-start implementation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * FLUX-1369: "Approve & start" for the compact surfaces (`PlanReviewActions` — the in-chat card and
 * the "Needs You" dock prompt) — the plain `approvePlanToTodo` commit, then
 * `dispatchApprovedImplementation`. `PlanApprovalPanel` does its OWN commit (it also persists staged
 * header edits and folds in annotation notes the compact cards don't have) and calls
 * `dispatchApprovedImplementation` directly instead of this wrapper.
 */
// eslint-disable-next-line react-refresh/only-export-components -- action helper colocated with the pending-interactions model it operates on (FLUX-1369); shared with PlanReviewActions.
export async function approvePlanAndStart(
  task: Task,
  config: Config | null | undefined,
  currentUser: string,
  notify: NotifyApi,
): Promise<void> {
  const updated = await updateTask(task.id, buildPlanApprovalUpdate(task, config, currentUser));
  await dispatchApprovedImplementation(updated, config, currentUser, notify);
}

/**
 * FLUX-1289/FLUX-1303: "Set aside" — the ONE dismiss level for a pending plan verdict, reachable
 * from every surface (chat card, AttentionDock tray item, board card's right-click context menu).
 * Clears `planReviewState` with NO revise dispatch — the dock item, lane, chat card, and board chip
 * all disappear together; the review comment stays in history as the record that it was seen and
 * set aside. FLUX-1303 retired the old second level (the dock-only tray-hide that kept the verdict
 * pending everywhere else) — two meanings for the same ✕ icon was a trap.
 */
// eslint-disable-next-line react-refresh/only-export-components -- action helper colocated with the pending-interactions model it operates on (FLUX-1289); shared across the chat-card/context-menu surfaces.
export async function dismissPlanReview(taskId: string, currentUser: string): Promise<void> {
  const now = new Date().toISOString();
  await updateTask(taskId, {
    planReviewState: null,
    planReviewBodyHash: null,
    // The one-pass gate stop writes a needsAction flag alongside the verdict — setting the verdict
    // aside must clear it too, or the card keeps flashing "Needs Action" with no surface left to act.
    needsAction: null,
    updatedBy: currentUser,
    appendHistory: [{
      type: 'activity',
      user: currentUser,
      date: now,
      comment: 'Plan review set aside — verdict cleared without a revise pass.',
    }],
  });
}

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
  // FLUX-1262: split into plain require-input vs. gate-parked (isGateParkedTicket) so a stalled
  // gate-auto loop gets its own ⛔ kind instead of reading as a generic question.
  const swimlaneRequireInputTickets = useAppSelector(
    (s) => s.tasks.filter((t) => t.swimlane === 'require-input'),
    shallowEqual,
  );
  const requireInputTickets = useMemo(
    () => swimlaneRequireInputTickets.filter((t) => !isGateParkedTicket(t)),
    [swimlaneRequireInputTickets],
  );
  const gateParkedTickets = useMemo(
    () => swimlaneRequireInputTickets.filter(isGateParkedTicket),
    [swimlaneRequireInputTickets],
  );

  // FLUX-1262: a `plan` gate's auto-review pass ran under `auto-then-you` and is sitting in `Grooming`
  // awaiting a human confirm (isPlanApprovalPending) — reads task + board config together since the
  // resolved gate value cascades ticket override -> board default.
  // FLUX-1319: `isPlanApprovalNeedsYou` excludes tickets the gate loop is actively driving
  // (`planGateRunning`) — while the auto-loop is mid review→revise→re-review the human is not needed,
  // so a "Revising…" item with no actions has no place in this blocking inbox (it appears here only
  // once the loop STOPS and awaits a human). The in-chat card / plan panel still reflect the
  // in-flight state via `isPlanApprovalPending`.
  const planApprovalTickets = useAppSelector(
    (s) => s.tasks.filter((t) => isPlanApprovalNeedsYou(t, s.config)),
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
  // with no live session. FLUX-1262: derived from the FULL swimlane set (incl. gate-parked) — a
  // stalled auto-loop still deserves the chat-tab badge, only the tray splits it into its own kind.
  const requireInputConversationIds = useMemo(
    () => new Set(swimlaneRequireInputTickets.map((t) => t.id)),
    [swimlaneRequireInputTickets],
  );

  const value = useMemo<PendingInteractionsValue>(
    () => ({
      requireInputTickets,
      planApprovalTickets,
      gateParkedTickets,
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
      planApprovalTickets,
      gateParkedTickets,
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
 * FLUX-1303: the reviewer feedback + plan-TL;DR block shared by the in-chat card and the
 * AttentionDock tray item. Feedback is ATTRIBUTED (reviewer vs "You" vs another human) instead of
 * an anonymous blob — the FLUX-1298 incident rendered a stale reviewer `APPROVED…` comment under a
 * "changes requested" banner with nothing saying who wrote it.
 */
export function PlanReviewFeedbackBlock({ task, clip = 300 }: { task: Task; clip?: number }) {
  const currentUser = useAppSelector((s) => s.currentUser);
  const changesRequested = task.planReviewState === 'changes-requested';
  // Memoized: this block mounts on every flagged card and re-renders per SSE tick — don't re-scan
  // a multi-KB body / full history each time.
  const feedback = useMemo(
    () => (changesRequested ? planReviewFeedback(task) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- feedback derives from exactly these two task facets
    [changesRequested, task.historyDigest, task.history],
  );
  const tldr = useMemo(() => planTldr(task.body), [task.body]);
  const label = feedbackAuthorLabel(feedback?.user, currentUser);
  const text = feedback && feedback.text.length > clip ? `${feedback.text.slice(0, clip).trimEnd()}…` : feedback?.text;
  return (
    <div className="flex flex-col gap-1.5">
      {changesRequested && (
        text ? (
          <div className="rounded-lg border-l-2 border-amber-400 bg-black/[0.03] px-2.5 py-1.5 dark:bg-white/[0.04]">
            <div className="text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">{label}</div>
            <div className="whitespace-pre-wrap break-words text-[12px] leading-snug text-gray-700 dark:text-gray-200">{text}</div>
          </div>
        ) : (
          <div className="text-[12px] text-gray-600 dark:text-gray-300">Changes requested — open the plan to read the full review.</div>
        )
      )}
      {tldr ? (
        <div className="text-[11.5px] leading-snug text-gray-500 dark:text-gray-400">
          <span className="font-semibold text-gray-600 dark:text-gray-300">Plan TL;DR:</span> {tldr}
        </div>
      ) : (
        // FLUX-1472: an approved plan with no TL;DR line would otherwise leave the card body
        // empty now that the verdict moved into the title.
        !changesRequested && (
          <div className="text-[12px] text-gray-600 dark:text-gray-300">Auto-reviewed and approved — open the plan to review.</div>
        )
      )}
    </div>
  );
}

/**
 * FLUX-1303: the ONE action set for a pending plan verdict, shared by the in-chat card and the
 * AttentionDock tray item (the panel composes the same verbs into its footer). One verb set on
 * every surface, emphasis flipped by verdict:
 *  - **Send for re-grooming** — expands an inline mini-composer, then one atomic engine call
 *    (`revisePlan` → `POST /plan-review/revise`). Notes optional on `changes-requested` (the
 *    reviewer's feedback already exists), REQUIRED on `approved` (overriding an approval needs a
 *    stated reason). Primary on `changes-requested`.
 *  - **Approve / Approve anyway** — Grooming → Todo, verdict cleared. Primary on `approved`.
 *  - "Re-run review" deliberately does NOT exist here — it lives only in `PlanApprovalPanel`,
 *    gated on the plan actually having changed since the verdict (re-reviewing an unchanged plan
 *    can only re-produce the same verdict — including re-approving a plan a human just rejected).
 * While `planGateRunning` (the gate loop or a dispatched revise in flight) everything collapses to
 * a live "Revising…" line. Failures render inline — never a silent catch (FLUX-1302).
 */
export function PlanReviewActions({ task, onOpenFull, openLabel, onSetAside, setAsideTitle }: {
  task: Task;
  onOpenFull?: () => void;
  openLabel?: string;
  onSetAside?: () => void | Promise<void>;
  /** FLUX-1312: ✕ tooltip override. The AttentionDock passes a "hide from this list" wording for its
   *  non-destructive dock-only dismiss; the chat card keeps the default verdict-clearing "Set aside". */
  setAsideTitle?: string;
}) {
  const config = useAppSelector((s) => s.config);
  const currentUser = useAppSelector((s) => s.currentUser);
  const { triggerRefresh } = useAppActions();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  // FLUX-1505: decision-collapse — the action row folds into a compact "chosen action" chip the
  // instant a verb is clicked (not after the POST resolves), and springs back open on failure.
  const [chosenLabel, setChosenLabel] = useState<string | null>(null);

  const changesRequested = task.planReviewState === 'changes-requested';
  const notesRequired = !changesRequested;

  async function run(action: () => Promise<void>, label: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setChosenLabel(label);
    try {
      await action();
      triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed — is the engine running?');
      setChosenLabel(null); // springs back open
    } finally {
      // Reset on success too — the card usually unmounts/flips via SSE right after, but if the
      // refresh is slow (or the server accepted without a visible state change) the buttons must
      // not stay wedged behind a permanent spinner. FLUX-1505 review fix: clear chosenLabel here
      // too, not just busy — otherwise that same no-visible-change case leaves the row permanently
      // collapsed as a done chip with no way back. A component that DOES unmount/flip via SSE
      // right after never renders this reset, so the normal decision-collapse feel is unaffected.
      setBusy(false);
      setChosenLabel(null);
    }
  }

  if (chosenLabel) {
    return (
      <div className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--eh-text-primary)] ${busy ? 'animate-pulse' : ''}`}>
        {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className="truncate">{chosenLabel}</span>
      </div>
    );
  }

  if (isPlanGateRevising(task)) {
    // FLUX-1306: keep the pure-navigation "Open full plan" link available while revising — dropping
    // it along with the dispatch buttons (which genuinely must hide, to avoid racing the in-flight
    // auto-loop revise) left no way to even LOOK at the plan from this card until the loop stopped.
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 text-[12px] italic text-gray-500 dark:text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revising — a grooming session is addressing the feedback…
        </span>
        {onOpenFull && (
          <Button
            variant="ghost"
            intent="neutral"
            size="sm"
            icon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={onOpenFull}
            className="underline-offset-2 hover:underline"
          >
            {openLabel ?? 'Open full plan'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {composing && (
        <textarea
          autoFocus
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={changesRequested ? 'Notes for the re-groom (optional — the reviewer feedback is included automatically)…' : 'What should change? Your notes become the re-groom instructions (required)…'}
          rows={2}
          className="w-full resize-none rounded-lg border border-black/10 bg-white/70 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--eh-state-attention)] dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* FLUX-1472: the open action is the filled primary and leads the row — the content it
            confirms isn't on screen yet, so reading the plan is the safe-forward action here. Both
            commit verbs (Approve, Send for re-grooming) stay quiet in this compact card context;
            they earn the fill only in `PlanApprovalPanel`, where the plan is actually visible. */}
        {!composing && onOpenFull && (
          <Button
            variant="filled"
            intent="accent"
            icon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={onOpenFull}
            disabled={busy}
          >
            {openLabel ?? 'Open full plan'}
          </Button>
        )}
        {!composing ? (
          <Button
            variant="quiet"
            intent="warn"
            icon={<Undo2 className="h-3.5 w-3.5" />}
            onClick={() => setComposing(true)}
            disabled={busy}
          >
            Send for re-grooming
          </Button>
        ) : (
          <>
            <Button
              variant="filled"
              intent="warn"
              icon={<Undo2 className="h-3.5 w-3.5" />}
              busy={busy}
              onClick={() => void run(() => revisePlan(task.id, currentUser, notes), 'Sending for re-grooming…')}
              disabled={busy || (notesRequired && !notes.trim())}
              title={notesRequired && !notes.trim() ? 'Add notes — overriding an approved plan needs a stated reason' : undefined}
            >
              Send for re-grooming
            </Button>
            <Button
              variant="ghost"
              intent="neutral"
              size="sm"
              onClick={() => { setComposing(false); setError(null); }}
              disabled={busy}
            >
              Cancel
            </Button>
          </>
        )}
        {/* FLUX-1369: parity with `PlanApprovalPanel`'s "Approve & start" (FLUX-1294) — only offered
            on an `approved` verdict, matching the panel (an explicit "Approve anyway" override on
            changes-requested stays a plain approve; auto-dispatching implementation on a plan the
            reviewer flagged is not the safe default). */}
        {!composing && !changesRequested && (
          <Button
            variant="quiet"
            intent="approve"
            icon={<Play className="h-3.5 w-3.5" />}
            busy={busy}
            onClick={() => void run(() => approvePlanAndStart(task, config, currentUser, notify), 'Approving & starting…')}
            disabled={busy}
            title="Approve into Todo, then immediately create a branch/worktree and dispatch an implementation session"
          >
            Approve & start
          </Button>
        )}
        {!composing && (
          <Button
            variant="quiet"
            intent="approve"
            icon={<Check className="h-3.5 w-3.5" />}
            busy={busy}
            onClick={() => void run(() => approvePlanToTodo(task, config, currentUser), changesRequested ? 'Approving anyway…' : 'Approving…')}
            disabled={busy}
            title={changesRequested ? 'Explicit override — moves to Todo despite the changes-requested verdict' : 'Move to Todo'}
          >
            {changesRequested ? 'Approve anyway' : 'Approve'}
          </Button>
        )}
        {!composing && onSetAside && (
          <Button
            variant="ghost"
            intent="neutral"
            size="icon"
            onClick={() => void run(async () => { await onSetAside(); }, 'Setting aside…')}
            disabled={busy}
            title={setAsideTitle ?? 'Set aside — clears the pending verdict everywhere; the review comment stays in history'}
            className="ml-auto"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {error && <div className="text-[11.5px] font-medium text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

/**
 * FLUX-1273/FLUX-1289/FLUX-1303: a flagged plan-approval ticket's in-chat card — additive to the
 * AttentionDock tray item, reusing the same inline-in-chat surface `ChatApprovalPanel`/
 * `ChatQuestionPicker` render (a themed card sitting above the composer). FLUX-1303 unified it onto
 * the shared `PlanReviewFeedbackBlock` + `PlanReviewActions` (same verbs as the dock item and the
 * panel): attributed feedback, plan TL;DR, an inline notes composer behind **Send for re-grooming**,
 * Approve/Approve-anyway, and a single ✕ **Set aside** that clears the verdict everywhere.
 */
function ChatPlanApprovalCard({ conversationId }: { conversationId: string }) {
  const task = useTaskById(conversationId);
  const config = useAppSelector((s) => s.config);
  const currentUser = useAppSelector((s) => s.currentUser);
  const { openPlanApproval } = useDockActions();

  if (!task || !isPlanApprovalPending(task, config)) return null;
  const changesRequested = task.planReviewState === 'changes-requested';

  return (
    <div className={`rounded-xl border p-3 shadow-sm ${changesRequested ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/50' : 'border-sky-300 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-950/50'}`}>
      <div className={`mb-1.5 flex items-center gap-1.5 text-xs font-bold ${changesRequested ? 'text-amber-700 dark:text-amber-300' : 'text-sky-700 dark:text-sky-300'}`}>
        {changesRequested ? <ClipboardX className="h-3.5 w-3.5" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
        {changesRequested ? 'Plan review requested changes' : 'Plan approved by auto-review — confirm'}
      </div>
      {/* FLUX-1472: the verdict now lives in the title above — spend the body line on the plan's
          TL;DR (PlanReviewFeedbackBlock renders it unconditionally) instead of restating it. */}
      <div className="mb-2">
        <PlanReviewFeedbackBlock task={task} clip={400} />
      </div>
      {/* FLUX-1306: keyed on the verdict — mirrors the AttentionDock tray item's
          `plan-approval:${id}:${verdict}` key — so a verdict flip while the user is mid-compose
          (typed re-groom notes) remounts this instead of carrying stale text across the flip. */}
      <PlanReviewActions
        key={task.planReviewState ?? 'none'}
        task={task}
        onOpenFull={() => openPlanApproval(task.id)}
        openLabel="Review plan"
        onSetAside={() => dismissPlanReview(task.id, currentUser)}
      />
    </div>
  );
}

/**
 * The unified inline prompt surface for one chat — mounted in a chat dock window and the task
 * modal's chat pane (the `questionPicker` slot of `ChatView`). Renders all three pending-prompt
 * types filtered to this `conversationId`. This is what makes every open chat a full prompt surface
 * for approvals, questions, and board-rebase batches alike. The same prompt also mirrors in the
 * unified attention surface (FLUX-898); resolution is single-flight via SSE, so there is no
 * double-submit even when both surfaces are mounted.
 *
 * The whole region is user-minimizable: prompt cards can eat most of a chat's height, hiding the
 * transcript the user may need to read before answering. "Hide" collapses every pending card to a
 * one-line count strip (nothing is dismissed or resolved); the strip — or a NEW prompt arriving —
 * restores the cards.
 */
export function ChatPendingInteractions({ conversationId }: { conversationId: string }) {
  const { approvals, questions, rebases, rebaseFailures, singleActiveConversationId } = usePendingInteractions();
  const task = useTaskById(conversationId);
  const config = useAppSelector((s) => s.config);
  // Minimized = the whole prompt region collapses to a one-line strip so the user can read the
  // transcript these cards were covering. Prompts are NOT dismissed — they stay pending (and keep
  // mirroring in the AttentionDock); the strip restores them on click.
  const [minimized, setMinimized] = useState(false);

  // What the four children below will actually render — mirrors their own per-conversation filters
  // (including ChatQuestionPicker's unrouted single-active claim and ChatPlanApprovalCard's
  // isPlanApprovalPending gate) so the minimize strip knows whether anything is pending and can
  // label itself with a live count.
  const count =
    approvals.filter((p) => p.conversationId === conversationId).length +
    rebases.filter((p) => p.conversationId === conversationId).length +
    rebaseFailures.filter((f) => f.conversationId === conversationId).length +
    questions.filter(
      (p) =>
        p.conversationId === conversationId ||
        (p.conversationId == null && singleActiveConversationId === conversationId),
    ).length +
    (task && isPlanApprovalPending(task, config) ? 1 : 0);

  // A NEW prompt arriving while minimized re-expands the region — minimize means "get these out of
  // my way for now", never "silence future prompts" (a fresh question hidden behind a strip the
  // user collapsed an hour ago would strand the agent).
  const prevCountRef = useRef(count);
  useEffect(() => {
    if (count > prevCountRef.current) setMinimized(false);
    prevCountRef.current = count;
  }, [count]);

  if (count === 0) return null;

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        title="Show the pending prompts"
        className="flex w-full shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11.5px] font-semibold text-primary transition-colors hover:bg-primary/10"
      >
        <BellRing className="h-3.5 w-3.5" />
        {count} pending prompt{count === 1 ? '' : 's'}
        <ChevronUp className="ml-auto h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    // `min-h-0 flex-1` keeps the FLUX-1413 bounded-height chain intact now that this wrapper div
    // sits between ChatView's questionPicker slot and ChatQuestionPicker's own flex-1 root.
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex shrink-0 items-center justify-end">
        <button
          type="button"
          onClick={() => setMinimized(true)}
          title="Minimize these prompts to a slim strip so you can read the chat behind them — nothing is dismissed, and a new prompt reopens them"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5"
        >
          <ChevronDown className="h-3 w-3" /> Hide
        </button>
      </div>
      <ChatApprovalPanel conversationId={conversationId} />
      <ChatBoardRebasePanel conversationId={conversationId} />
      <ChatQuestionPicker conversationId={conversationId} />
      <ChatPlanApprovalCard conversationId={conversationId} />
    </div>
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
