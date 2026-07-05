// The Furnace — the BatchStoker (FLUX-1008 → FLUX-1053 batch redesign).
//
// The background loop that burns each batch's tickets. Unlike the old single-active-run model, MANY
// batches burn independently and concurrently, bounded only by the global worktree-slot cap. Per tick,
// for each `burning` batch it:
//   A. reconciles in-flight tickets — observes each ticket's session and advances it, and
//   B. feeds new coal — starts the next queued ticket(s) up to the batch's burn rate AND the global
//      worktree-slot cap, then
//   C. completes the batch when every ticket has reached a terminal state.
// It also runs a lightweight trigger watcher that auto-ignites a draft batch once its trigger is met.
//
// Two batch KINDS (FLUX-1053):
//   sequential — all tickets share ONE branch + ONE PR on one dedicated worktree, burning strictly in
//                order (burn rate forced to 1). The anchor (lowest order) creates the branch/worktree;
//                followers reuse it (skip isolation) so their commits stack. A parked member poisons
//                the shared base → the rest of the batch is skipped.
//   parallel   — each ticket burns in its own worktree and opens its own PR at burn-rate concurrency.
//                A parked ticket is isolated — the other tickets keep burning.
//
// Per-ticket lifecycle (the invariant): implement -> review -> read reviewState ->
//   approved          -> leave the PR open at Ready, mark `pr-open`  (NEVER finish_ticket)
//   changes-requested -> re-implement while attempts < retryCap, else park
//   no verdict, but the last comment looks like a verdict (FLUX-1078) -> ONE corrective nudge, then park
//   no verdict (no marker) / fail / waiting-input -> park (needs a human; stays In Progress + Require Input swimlane)

import { getEnginePort } from './packaged-mode.js';
import { log } from './log.js';
import { configCache } from './config.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { addNotification } from './notifications.js';
import { cliSessionsById, getActiveSessionsForTask, stopAllSessionsForTask } from './session-store.js';
import type { CliSessionStatus } from './agents/types.js';
import {
  getFurnaceBatch,
  getFurnaceBatchesCache,
  getBurningBatches,
  mutateFurnaceBatch,
  claimSlotsAndIgnite,
  ensureFurnaceLoaded,
  freeSlots,
  setObservedWorktrees,
  FURNACE_SLOT_CAP,
} from './furnace-store.js';
import {
  type FurnaceBatch,
  type BatchTicket,
  type BatchTicketState,
  type BatchPr,
  type BatchPrReviewState,
  type FurnacePhase,
  type FailureClass,
  type TicketOwner,
  isActiveTicketState,
  isHumanOwned,
  isBatchTerminal,
  nextQueuedTicket,
  activeTicketCount,
  terminalTicketCount,
  allTicketsSettled,
  assembleBurnReport,
  effectiveConcurrency,
  isSequentialFollower,
  furnaceReservedTicketIds,
  clampBurnRate,
  MAX_BURN_RATE,
  DEFAULT_RATE_LIMIT_RETRY_INTERVAL_MS,
  DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
} from './models/furnace.js';
import { DEFAULT_MAX_TASK_WORKTREES, listTaskWorktrees, ticketIdFromWorktreePath } from './task-worktree.js';
import { requireWorkspaceRoot } from './workspace.js';
import { postPrReview } from './branch-manager.js';
import { reclaimReadyWorktrees, worktreeUnreclaimableReason, type UnreclaimableReason } from './pr-cleanup.js';
import { runGit } from './git-exec.js';

const STOKE_INTERVAL_MS = 5_000;

const nowIso = () => new Date().toISOString();
const engineBase = () => `http://127.0.0.1:${getEnginePort()}`;

function findTicket(batch: FurnaceBatch, ticketId: string): BatchTicket | undefined {
  return batch.tickets.find((t) => t.ticketId === ticketId);
}

/** The worktree-slot cap the Furnace enforces globally (kept in sync with the task-worktree pool). */
export const FURNACE_WORKTREE_CAP = DEFAULT_MAX_TASK_WORKTREES;

/** The focus handed to a re-implementation session (after changes-requested, or a rate-limit retry of one). */
const REIMPLEMENT_FOCUS = 'Address the latest review feedback (changes-requested), commit, and return the ticket to Ready.';

/**
 * FLUX-1078: every built-in reviewer persona prompt (orchestration-personas.ts) says "do NOT call
 * change_status unless your focus instructions explicitly say you are the SOLE reviewer" — a hedge for
 * multi-reviewer synthesis flows. The Furnace only ever dispatches ONE reviewer per ticket, but never
 * said so via `focusComment`, so the persona correctly (per its own prompt) withheld the `change_status`
 * call, wrote a plain "**APPROVED**" comment, and the ticket got parked as if the review never happened.
 * This focus note is what authorizes the persona to actually record its verdict.
 */
const SOLE_REVIEWER_FOCUS = 'You are the ONLY reviewer for this ticket in this Furnace run — no orchestrator will synthesize other reviews, so you own the decision. Your review is not complete until you call `change_status` with `reviewState` set to "approved" or "changes-requested" to match your verdict. Posting a comment that starts with **APPROVED** or **CHANGES NEEDED** is not enough by itself — without the `change_status` call, the ticket will be parked for a human to unblock even though your review already happened.';

/** FLUX-1078: the one-shot corrective focus for a review session whose prior pass left a verdict-shaped comment but never called `change_status`. */
const REVIEW_NUDGE_FOCUS = 'Your previous review comment on this ticket already reads like a verdict (it started with **APPROVED** or **CHANGES NEEDED**), but `change_status` was never called to record it, so the ticket was about to be parked for a human over that alone. You are the sole reviewer for this ticket. Read your own last review comment, then call `change_status` now with `reviewState` set to match it (\'approved\' or \'changes-requested\'), and end your turn. Do not re-review the diff from scratch.';

/** Furnace review-phase dispatch options: the configured persona (if any) plus the sole-reviewer focus every review session needs to actually record its verdict. */
function reviewDispatchOpts(batch: FurnaceBatch): { personaId?: string; focusComment: string } {
  return { ...(batch.reviewPersonaId ? { personaId: batch.reviewPersonaId } : {}), focusComment: SOLE_REVIEWER_FOCUS };
}

/** Exported for tests (FLUX-1080): assert this exact string is what reaches the outgoing dispatch body. */
export { SOLE_REVIEWER_FOCUS };

/**
 * FLUX-1078: narrow pattern-match on the known review-verdict convention — every built-in reviewer
 * persona is told to start its `add_note` comment with **APPROVED** or **CHANGES NEEDED**. This is
 * deliberately NOT a general sentiment/verdict classifier — it only recognizes that one documented
 * prefix, and a false negative (no match) falls back to today's park behavior at zero extra cost.
 */
const VERDICT_MARKER_RE = /^\s*\*\*\s*(APPROVED|CHANGES\s+NEEDED)\s*\*\*/i;

/**
 * True when the ticket's most recent history comment POSTED DURING THE CURRENT REVIEW PASS matches the
 * verdict-marker convention above. `sinceIso` scopes the scan to entries dated on/after it (the current
 * review session's `sessionStartedAt`) so a stale comment from a PRIOR review round (before the ticket was
 * re-implemented and re-reviewed) can't be mistaken for this round's verdict — see FLUX-1080. Entries whose
 * date can't be confirmed to be within the window are skipped rather than counted, matching the safe
 * (park-by-default) posture of the caller.
 */
export function lastCommentMatchesVerdictMarker(history: unknown, sinceIso?: string): boolean {
  if (!Array.isArray(history)) return false;
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (!e || typeof e !== 'object') continue;
    if (!Number.isNaN(sinceMs)) {
      const entryMs = typeof e.date === 'string' ? Date.parse(e.date) : NaN;
      if (Number.isNaN(entryMs) || entryMs < sinceMs) continue;
    }
    if (e.type === 'comment' && typeof e.comment === 'string') return VERDICT_MARKER_RE.test(e.comment);
  }
  return false;
}

/**
 * FLUX-1063: the phase that runs a given ticket state. Single source of truth for the state→phase
 * mapping so the cooldown decision (which phase to retry) and the retry executor (which session to spawn)
 * can't drift out of sync. `reviewing` → review; everything else (implementing/reimplementing) → impl.
 */
function phaseForState(state: BatchTicketState | undefined): FurnacePhase {
  return state === 'reviewing' ? 'review' : 'implementation';
}

// ── Pure decision core (unit-tested) ─────────────────────────────────────────

export type TicketAction =
  | { type: 'wait' }
  | { type: 'review' }
  | { type: 'reimplement'; attempt: number }
  | { type: 'pr-open'; prUrl?: string }
  // FLUX-1066: a park now carries its failure CLASS (needs-input vs hard-fail) so the drawer can render
  // the cause + a next action instead of a single opaque `parked` badge. transient/recoverable never
  // reach here (they're handled by cooldown / retry-exhausted above).
  | { type: 'park'; reason: string; failureClass: FailureClass }
  | { type: 'redrive'; phase: FurnacePhase }
  // FLUX-1047: the ticket's session died from context-window exhaustion (recoverable) — re-drive the
  // current phase with a FRESH session. `attempt` is the new exhaustionAttempts value to persist.
  | { type: 'retry-exhausted'; phase: FurnacePhase; attempt: number }
  // FLUX-1063: the ticket's session died from a transient usage/rate limit — enter (or remain in) a
  // cooldown instead of parking. advanceTicket records the cooldown clock + next retry time and moves
  // the ticket to the `cooling-down` state. Does NOT consume retryCap / the circuit breaker.
  | { type: 'cooldown-rate-limited' }
  // FLUX-1063: a cooling-down ticket's retry window elapsed — restore its phase and spawn a FRESH
  // session (no `--resume`). `attempt` is the new rateLimitAttempts value to persist.
  | { type: 'retry-rate-limited'; phase: FurnacePhase; attempt: number }
  // FLUX-1078: the review session completed with `reviewState` unset, but its last comment matched the
  // known verdict-marker convention — give it ONE corrective pass to record the verdict via
  // `change_status` before falling back to a park. Capped by `ticket.reviewNudgeSent`.
  | { type: 'review-nudge' };

/**
 * Decide what to do next for a single active ticket, given its session status + the ticket's review
 * verdict. Pure — no I/O — so every branch is unit-testable. `sessionStatus: undefined` means no
 * observable session (lost/never-recorded, e.g. after an engine restart) → re-drive the current phase.
 */
export function decideTicketAction(input: {
  ticket: BatchTicket;
  sessionStatus?: CliSessionStatus;
  terminalReason?: 'context-exhausted' | 'rate-limited';
  // FLUX-1156: the failed/cancelled session's own recorded outcome (its agent_session entry's
  // `outcome`, e.g. "Claude Code session failed to start: refusing to run the agent on master") — when
  // present, folded into the park reason instead of the opaque generic "session ended failed" so a
  // human (or a re-reading agent) sees WHY without having to dig through session history.
  sessionOutcome?: string;
  reviewState?: 'approved' | 'changes-requested' | null;
  ticketStatus?: string;
  requireInputStatus?: string;
  retryCap: number;
  exhaustionRetryCap?: number;
  prUrl?: string;
  // FLUX-1078: computed by the caller (I/O) from the ticket's last comment — see `lastCommentMatchesVerdictMarker`.
  reviewVerdictMarkerSeen?: boolean;
  // FLUX-1063: rate-limit cooldown inputs (only consulted for the rate-limited paths).
  nowMs?: number;
  rateLimitRetryIntervalMs?: number;
  rateLimitMaxWaitMs?: number;
}): TicketAction {
  const { ticket, sessionStatus, terminalReason, reviewState, ticketStatus, retryCap } = input;
  const requireInput = input.requireInputStatus || 'Require Input';
  const currentPhase: FurnacePhase = ticket.state === 'reviewing' ? 'review' : 'implementation';

  // FLUX-1063: a ticket cooling down after a rate limit — decide retry vs. keep waiting vs. give up.
  // Handled BEFORE the active-state gate below, since `cooling-down` is deliberately non-active.
  if (ticket.state === 'cooling-down') {
    const nowMs = input.nowMs ?? Date.now();
    const maxWaitMs = input.rateLimitMaxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
    const firstSeen = ticket.rateLimitFirstSeenAt ? Date.parse(ticket.rateLimitFirstSeenAt) : nowMs;
    if (!Number.isNaN(firstSeen) && nowMs - firstSeen >= maxWaitMs) {
      const hrs = Math.round((maxWaitMs / 3_600_000) * 10) / 10;
      return { type: 'park', reason: `rate limit did not clear within the ${hrs}h ceiling — failing outright`, failureClass: 'hard-fail' };
    }
    const nextRetry = ticket.nextRetryAt ? Date.parse(ticket.nextRetryAt) : 0;
    if (!Number.isNaN(nextRetry) && nowMs < nextRetry) return { type: 'wait' };
    // Retry window elapsed — restore the pre-cooldown phase and spawn fresh.
    return { type: 'retry-rate-limited', phase: phaseForState(ticket.preCooldownState), attempt: (ticket.rateLimitAttempts ?? 0) + 1 };
  }

  if (!isActiveTicketState(ticket.state)) return { type: 'wait' };

  // No observable session → the phase never recorded a session or the engine restarted: re-drive it.
  if (sessionStatus === undefined) return { type: 'redrive', phase: currentPhase };

  // Still working.
  if (sessionStatus === 'pending' || sessionStatus === 'running') return { type: 'wait' };

  // The agent parked itself waiting for input — an unattended run can't answer, so it needs a human.
  if (sessionStatus === 'waiting-input') {
    return { type: 'park', reason: `the ${currentPhase} session is waiting for input (an unattended run can't answer)`, failureClass: 'needs-input' };
  }

  // FLUX-1047: context-window exhaustion is RECOVERABLE — a fresh session very likely continues fine.
  if (sessionStatus === 'failed' && terminalReason === 'context-exhausted') {
    const cap = input.exhaustionRetryCap ?? 0;
    const used = ticket.exhaustionAttempts ?? 0;
    if (used < cap) return { type: 'retry-exhausted', phase: currentPhase, attempt: used + 1 };
    return { type: 'park', reason: `the ${currentPhase} session ran out of context ${cap} time(s) — retries spent`, failureClass: 'hard-fail' };
  }

  // FLUX-1063: a usage/rate limit is TRANSIENT — cool the ticket down and auto-retry rather than park.
  // The retry cadence + ceiling are handled by the `cooling-down` branch above once advanceTicket moves
  // the ticket there; here we just make the entry decision.
  if (sessionStatus === 'failed' && terminalReason === 'rate-limited') {
    return { type: 'cooldown-rate-limited' };
  }

  // Terminal but unsuccessful — a crash/cancel is a bad state, not a human question.
  if (sessionStatus === 'failed' || sessionStatus === 'cancelled') {
    const reason = input.sessionOutcome
      ? `the ${currentPhase} session ended ${sessionStatus} — ${input.sessionOutcome}`
      : `the ${currentPhase} session ended ${sessionStatus}`;
    return { type: 'park', reason, failureClass: 'hard-fail' };
  }

  // sessionStatus === 'completed'
  if (ticket.state === 'implementing' || ticket.state === 'reimplementing') {
    if (ticketStatus && ticketStatus === requireInput) {
      return { type: 'park', reason: 'implementation ended with the ticket in Require Input', failureClass: 'needs-input' };
    }
    return { type: 'review' };
  }

  // ticket.state === 'reviewing' — read the verdict the reviewer recorded via change_status.
  if (reviewState === 'approved') {
    return input.prUrl !== undefined ? { type: 'pr-open', prUrl: input.prUrl } : { type: 'pr-open' };
  }
  if (reviewState === 'changes-requested') {
    if (ticket.attempts < retryCap) return { type: 'reimplement', attempt: ticket.attempts + 1 };
    // Review kept requesting changes past the cap — a human must decide how to proceed.
    return { type: 'park', reason: `review still requesting changes after ${retryCap} re-implementation attempt(s)`, failureClass: 'needs-input' };
  }
  // FLUX-1078: no verdict, but the last comment already reads like one (**APPROVED**/**CHANGES NEEDED**)
  // — give it ONE corrective pass before treating this as the anomaly it usually is. Capped by
  // `reviewNudgeSent` so a persona that ignores the nudge can't loop forever.
  if (input.reviewVerdictMarkerSeen && !ticket.reviewNudgeSent) {
    return { type: 'review-nudge' };
  }
  // The reviewer finished but recorded no verdict — an anomaly (bad state), not a posed question.
  return { type: 'park', reason: 'review completed without a verdict (reviewState unset)', failureClass: 'hard-fail' };
}

// ── Session status helpers ────────────────────────────────────────────────────

export function isTerminalSession(status: CliSessionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Pure: pick the active session that belongs to a Furnace phase (never the persistent chat session). */
export function pickSessionForPhase<T extends { phase?: string }>(sessions: readonly T[], phase: FurnacePhase): T | undefined {
  return sessions.find((s) => s.phase === phase);
}

function activeSessionForPhase(ticketId: string, phase: FurnacePhase) {
  return pickSessionForPhase(getActiveSessionsForTask(ticketId), phase);
}

const MAX_SPAWN_ATTEMPTS = 6;

// ── I/O executors ─────────────────────────────────────────────────────────────

interface TicketWithPrLinks {
  implementationLink?: string;
  prUrl?: string;
  pr?: { url?: string };
  pullRequest?: { url?: string };
}

function extractPrUrl(task: TicketWithPrLinks | null | undefined): string | undefined {
  if (!task) return undefined;
  return task.implementationLink || task.prUrl || task.pr?.url || task.pullRequest?.url || undefined;
}

/**
 * FLUX-1156: the ticket's own recorded `outcome` for a given session id, read straight off durable
 * history (`tasksCache`, kept current by `updateTaskWithHistory`/`updateAgentSession`) rather than the
 * in-memory `CliSessionRecord` — the adapters only ever mutate the ON-DISK entry's `outcome` via
 * `updateAgentSession` (see claude-code.ts's exit handler), never the in-memory `sessionHistoryEntry`
 * copy, so reading history here is what makes this work uniformly for BOTH a pre-spawn failure (which
 * sets both copies) and an ordinary post-spawn one (which only ever updates the durable copy).
 */
export function findSessionOutcome(task: { history?: unknown[] } | null | undefined, sessionId: string | undefined): string | undefined {
  if (!task || !sessionId || !Array.isArray(task.history)) return undefined;
  for (let i = task.history.length - 1; i >= 0; i--) {
    const e = task.history[i] as { type?: string; sessionId?: string; outcome?: string } | undefined;
    if (e?.type === 'agent_session' && e.sessionId === sessionId && typeof e.outcome === 'string' && e.outcome.trim()) {
      return e.outcome.trim();
    }
  }
  return undefined;
}

/**
 * Spawn a phase session for a ticket on the loopback engine, reusing the sanctioned start route
 * (server-side worktree isolation/reuse). Returns the new session id, or null if the spawn was refused.
 */
async function dispatchSession(
  ticketId: string,
  phase: FurnacePhase,
  opts: { personaId?: string; focusComment?: string; skipIsolation?: boolean } = {},
): Promise<string | null> {
  // A sequential follower reuses the anchor's shared worktree (resolved server-side by the shared
  // branch), so it must NOT request isolation — that would check the same branch out twice.
  const body: Record<string, unknown> = {
    phase,
    ...(opts.skipIsolation ? {} : { isolation: 'worktree' }),
    skipPermissions: true,
    patternPosition: 'standalone',
    user: 'Furnace',
  };
  if (opts.personaId) body.personaId = opts.personaId;
  if (opts.focusComment) body.focusComment = opts.focusComment;
  try {
    const res = await fetch(`${engineBase()}/api/tasks/${encodeURIComponent(ticketId)}/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      log.warn(`[furnace] spawn ${phase} for ${ticketId} refused (${res.status}): ${err?.error || res.statusText}`);
      return null;
    }
    const j = (await res.json().catch(() => ({}))) as { session?: { id?: string } };
    return j.session?.id ?? null;
  } catch (e: unknown) {
    log.warn(`[furnace] spawn ${phase} for ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Clear a stale review verdict before dispatching a fresh review (it persists across re-impl by design). */
async function clearReviewState(ticketId: string): Promise<void> {
  const t = tasksCache[ticketId];
  if (t && t.reviewState != null) {
    try {
      await updateTaskWithHistory(ticketId, { extraFields: { reviewState: null }, updatedBy: 'Furnace' });
    } catch (e: unknown) {
      log.warn(`[furnace] clear reviewState on ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The In-Progress status a parked ticket should rest in (mirrors mcp-server's status derivation). */
function inProgressStatus(): string {
  const columnNames: string[] = (configCache.columns || []).map((c: { name: string }) => c.name);
  const i = columnNames.findIndex((c) => c.toLowerCase() === 'todo');
  return (i >= 0 && i + 1 < columnNames.length ? columnNames[i + 1] : undefined) || 'In Progress';
}

/** Park a ticket for a human: keep it in its working column and raise the `require-input` swimlane. */
async function parkTicketOnBoard(ticketId: string, reason: string): Promise<void> {
  try {
    await updateTaskWithHistory(ticketId, {
      nextStatus: inProgressStatus(),
      entries: [{
        type: 'comment',
        user: 'Furnace',
        comment: `Parked by the Furnace: ${reason}. Needs your input before this ticket can continue.`,
        date: nowIso(),
      }],
      extraFields: { swimlane: 'require-input' },
      updatedBy: 'Furnace',
    });
  } catch (e: unknown) {
    log.warn(`[furnace] park ${ticketId} swimlane flag failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try { stopAllSessionsForTask(ticketId, 'furnace parked ticket'); } catch { /* best effort */ }
}

// ── Reconciliation against ground truth (FLUX-1066 §1–2) ──────────────────────────

/**
 * The board statuses that mean a ticket has SUCCEEDED outside the Furnace (reached Ready/Done/merged).
 * A Furnace-managed ticket that lands here — because a human drove it to completion — should be reflected
 * as `pr-open` rather than left stuck at whatever the Furnace last wrote. Derived from config with sane
 * fallbacks; matched case-insensitively.
 */
function boardSuccessStatuses(): string[] {
  const ready = (configCache.readyForMergeStatus as string) || 'Ready';
  const archive = (configCache.archiveStatus as string) || 'Archived';
  return [ready, 'Done', 'Released', archive].map((s) => s.toLowerCase());
}

function isBoardSuccessStatus(status: string | undefined): boolean {
  return status !== undefined && boardSuccessStatuses().includes(status.toLowerCase());
}

/**
 * FLUX-1066 pure core (M1): is a HUMAN driving this ticket? True when a genuinely LIVE session
 * (`pending`/`running` — NOT a stalled `waiting-input` stub) exists on the ticket whose id the Furnace is
 * NOT tracking in `sessionIds`. IDENTITY, not phase, is the signal: the Furnace records every phase session
 * it spawns in `sessionIds`, so any live session absent from that list is a human's.
 *
 * This replaces the earlier phase-based heuristic, which had two false-detection bugs (M1):
 *   (a) it exempted only `implementation`/`review` phases, so a human who explicitly `start_session`ed one
 *       of those on a Furnace ticket slipped through as still `owner: furnace`, while a legitimate
 *       grooming/finalize session tripped a handoff; and
 *   (b) it counted stalled `waiting-input` sessions (an abandoned stub) as an active takeover with no expiry.
 *
 * FLUX-1090: `isDispatching` is true while a spawn for this exact ticket is in flight (between `feedCoal`
 * deciding to dispatch it and `setInFlight` recording the new session's id) — during that window the
 * freshly-spawned session is live but genuinely not yet in `ticket.sessionIds`, so without this short-circuit
 * the Furnace would misidentify its OWN session as a human's. See the `dispatching` set below.
 */
export function isHumanTakeover(
  sessions: readonly { id: string; status: CliSessionStatus; phase?: string }[],
  ticket: Pick<BatchTicket, 'sessionIds'>,
  isDispatching = false,
): boolean {
  if (isDispatching) return false;
  return sessions.some(
    (s) => (s.status === 'pending' || s.status === 'running') && !ticket.sessionIds.includes(s.id),
  );
}

/**
 * FLUX-1090: ticket ids with a `feedCoal` spawn currently in flight — added right before the dispatch
 * (crash-adopt or `spawnOrCount`) and removed once `setInFlight` has recorded the session, so the window
 * where the ticket is still `queued` (not yet caught by `isActiveTicketState`) but its new session is
 * already live is never visible to `reconcileBatch` as a foreign session. In-memory only: a crash mid-spawn
 * is already recovered by the pre-existing orphaned-session adoption in `feedCoal`/`reconcileTicket`.
 */
const dispatching = new Set<string>();

/**
 * FLUX-1095: true while `feedCoal` has a spawn for `ticketId` in flight (dispatched but not yet recorded
 * onto the batch by `setInFlight`). Exported so callers outside this module — the `furnace_ticket`
 * "remove" guard (mcp-server.ts) — can refuse to remove a ticket mid-spawn: during this window the
 * ticket is still `queued`, so the ordinary "queued tickets can always be removed" rule would otherwise
 * let a human orphan the freshly-spawned session (the same leaked-slot failure mode FLUX-1090 fixed for
 * takeover, reappearing through the removal door).
 */
export function isDispatching(ticketId: string): boolean {
  return dispatching.has(ticketId);
}

/**
 * FLUX-1090 (defense in depth): ticket ids whose LAST reconcile pass observed what looked like a human
 * takeover. `reconcileBatch` only ACTS on it once the condition holds on two consecutive passes — a lone
 * transient blip (e.g. a poll that slips past the `dispatching` guard) can never misfire ownership on its
 * own; it takes a second pass to confirm. Cleared as soon as a pass no longer sees it.
 */
const suspectedHumanTakeover = new Set<string>();

function detectHumanTakeover(ticket: BatchTicket): boolean {
  return isHumanTakeover(getActiveSessionsForTask(ticket.ticketId), ticket, dispatching.has(ticket.ticketId));
}

/**
 * FLUX-1090: debounce a raw per-tick takeover observation into a confirmed one — true only the SECOND
 * consecutive time `raw` is true for this ticket. Mutates `suspectedHumanTakeover` as its debounce memory.
 */
function debouncedTakeover(ticketId: string, raw: boolean): boolean {
  if (!raw) {
    suspectedHumanTakeover.delete(ticketId);
    return false;
  }
  if (suspectedHumanTakeover.has(ticketId)) return true;
  suspectedHumanTakeover.add(ticketId);
  return false;
}

/**
 * FLUX-1094: a ticket leaving Furnace ownership entirely (removed from a batch, or its batch discarded)
 * must not carry stale takeover-debounce state into whatever comes next. Neither `suspectedHumanTakeover`
 * nor `dispatching` was cleared on removal — only a later reconcile pass observing `raw === false` cleared
 * the former, so a re-entrant ticket id could land in a NEW batch with a leftover "suspected" entry and have
 * its very first transient blip there misread as the SECOND consecutive pass, confirming a takeover
 * immediately and bypassing the two-pass debounce this Set exists to enforce.
 */
export function clearTakeoverTracking(ticketId: string): void {
  suspectedHumanTakeover.delete(ticketId);
  dispatching.delete(ticketId);
}

/** Clear the Furnace-raised `require-input` swimlane on a ticket (best-effort; no-op if not set). */
async function clearFurnaceFlag(ticketId: string, note?: string): Promise<void> {
  const t = tasksCache[ticketId];
  if (!t || t.swimlane !== 'require-input') return;
  try {
    await updateTaskWithHistory(ticketId, {
      extraFields: { swimlane: null },
      ...(note ? { entries: [{ type: 'comment', user: 'Furnace', comment: note, date: nowIso() }] } : {}),
      updatedBy: 'Furnace',
    });
  } catch (e: unknown) {
    log.warn(`[furnace] clear flag on ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * FLUX-1066 — the reconciling controller. For every ticket in a non-draft batch, observe GROUND TRUTH
 * (the live board status + the session registry) and close the gap to intent, rather than trusting the
 * last value the Stoker wrote. Idempotent and cheap: it reads in-memory caches and writes ONLY when
 * something actually changed, so it is safe to run every tick AND on each read (furnace_get / GET).
 *
 * Two reconciliations, applied only to tickets the Stoker is NOT actively driving (leaving live impl/review
 * to `reconcileTicket`'s normal flow):
 *   1. Ownership handoff — a non-Furnace live session on the ticket flips it to `owner: human`. The Furnace
 *      then yields (never parks/reclaims it) and the drawer shows "you're driving this".
 *   2. Board terminal-success — a ticket a human took to Ready/Done/merged flips to `pr-open`, its flag
 *      drops, and (for a terminal batch) the burn report is regenerated so it's never stuck `parked`.
 */
export interface ReconcileChange {
  ticketId: string;
  owner?: TicketOwner;
  reflectPrOpen?: boolean;
  prUrl?: string;
  /** Drop the Furnace-raised `require-input` board flag as part of applying this change. */
  dropFlag?: boolean;
}

/**
 * FLUX-1066 pure core: given a NON-active ticket + ground truth, decide its reconciliation. Callers guard on
 * `isActiveTicketState` (live impl/review is reconcileTicket's job), so this only sees settled/queued/cooling
 * tickets. A board-success reflection WINS over a takeover (the ticket is done, not being driven). BOTH
 * outcomes drop the Furnace board flag (`dropFlag`) — B1: a taken-over ticket must NOT keep an undismissable
 * `require-input` flag whose only escape was handing it back to the Furnace. Returns null when nothing changed.
 */
export function decideReconcile(
  ticket: BatchTicket,
  gt: { takenOver: boolean; boardSuccess: boolean; prUrl?: string },
): ReconcileChange | null {
  if (gt.boardSuccess && ticket.state !== 'pr-open' && ticket.state !== 'skipped') {
    const c: ReconcileChange = { ticketId: ticket.ticketId, reflectPrOpen: true, dropFlag: true };
    if (gt.prUrl !== undefined) c.prUrl = gt.prUrl;
    return c;
  }
  if (!isHumanOwned(ticket) && gt.takenOver) {
    return { ticketId: ticket.ticketId, owner: 'human', dropFlag: true };
  }
  return null;
}

export async function reconcileBatch(batchId: string): Promise<void> {
  const batch = getFurnaceBatch(batchId);
  if (!batch || batch.status === 'draft') return;

  const changes: ReconcileChange[] = [];
  for (const ticket of batch.tickets) {
    // Leave tickets the Stoker is actively driving to reconcileTicket (which mirrors the review verdict).
    if (isActiveTicketState(ticket.state)) continue;
    const task = tasksCache[ticket.ticketId];
    const prUrl = extractPrUrl(task);
    const change = decideReconcile(ticket, {
      takenOver: debouncedTakeover(ticket.ticketId, detectHumanTakeover(ticket)),
      boardSuccess: isBoardSuccessStatus(task?.status),
      ...(prUrl !== undefined ? { prUrl } : {}),
    });
    if (change) changes.push(change);
  }
  if (changes.length === 0) return;

  const flaggedForDrop: string[] = [];
  await mutateFurnaceBatch(batchId, (b) => {
    for (const c of changes) {
      const t = findTicket(b, c.ticketId);
      if (!t) continue;
      if (c.reflectPrOpen) {
        t.state = 'pr-open';
        if (c.prUrl) t.prUrl = c.prUrl;
        t.lastReviewState = 'approved';
        if (!t.endedAt) t.endedAt = nowIso();
        t.note = 'completed outside the Furnace (reflected from the board)';
        delete t.failureClass;
        delete t.currentSessionId;
        delete t.currentPhase;
        clearCooldownState(t);
      } else if (c.owner === 'human') {
        // FLUX-1090: settle it exactly like an EXPLICIT takeover (takeoverTicket) — minus stopping the
        // session, which here is the human's own.
        settleAsHumanOwned(t);
      }
      // B1: both a reflected success AND an auto-detected takeover clear the board flag — a human-owned
      // ticket must never be left carrying a require-input flag it can't dismiss.
      if (c.dropFlag) flaggedForDrop.push(c.ticketId);
    }
    // A terminal batch's report lists tickets by state — regenerate it so a reflected ticket moves out
    // of `parked`/`failed` and into `prsOpened`.
    if (isBatchTerminal(b.status)) b.report = assembleBurnReport(b, nowIso());
  });
  for (const ticketId of flaggedForDrop) await clearFurnaceFlag(ticketId);
}

// ── Read-path reconcile gating (FLUX-1145) ──────────────────────────────────────
//
// The portal polls GET /api/furnace every ~3s (FurnaceDrawer.tsx POLL_MS) and every poll used to run
// `reconcileBatch` for EVERY batch before answering — measured at 1.1s avg / 3.4s worst-case. `reconcileBatch`
// itself must stay uncached: `stokerTick`/`driveBurningBatches` call it directly, every drive-cycle tick,
// and that is what actually closes the FLUX-1066/1067 ground-truth gap — this gate only throttles how often
// a READ re-triggers it. Mirrors the `refreshWorktreePool` TTL + single-flight pattern above (FLUX-1069):
// a call within the TTL of the last completed reconcile for that key is skipped outright, and concurrent
// callers for the same key share one in-flight pass — so a stampede of polls racing past an expired TTL
// runs the work once, not N times.
const RECONCILE_READ_TTL_MS = 3_000;
const reconcileReadInFlight = new Map<string, Promise<void>>();
const reconcileReadAt = new Map<string, number>();

async function gatedReconcile(key: string, run: () => Promise<void>): Promise<void> {
  const inFlight = reconcileReadInFlight.get(key);
  if (inFlight) return inFlight;
  if (Date.now() - (reconcileReadAt.get(key) ?? 0) < RECONCILE_READ_TTL_MS) return;
  const p = (async () => {
    try {
      await run();
      // Only a successful pass counts as "fresh" — stamping this on a thrown error would mask the
      // failure as a completed reconcile for the rest of the TTL window (FLUX-1145 review fix).
      reconcileReadAt.set(key, Date.now());
    } finally {
      reconcileReadInFlight.delete(key);
    }
  })();
  reconcileReadInFlight.set(key, p);
  return p;
}

/** TTL-gated `reconcileBatch(batchId)` for read paths (GET /:id, furnace_get with a batchId). */
export async function reconcileBatchCached(batchId: string): Promise<void> {
  return gatedReconcile(batchId, () => reconcileBatch(batchId));
}

/** TTL-gated "reconcile every batch" for read paths (GET /, furnace_get without a batchId). */
export async function reconcileAllBatchesCached(): Promise<void> {
  return gatedReconcile('*', async () => {
    for (const b of getFurnaceBatchesCache()) await reconcileBatch(b.id);
  });
}

/**
 * FLUX-1166: `deleteFurnaceBatch` lives in furnace-store.ts and never touches this module's read-gate
 * caches, so a deleted batch's `reconcileReadAt`/`reconcileReadInFlight` entry (keyed on its id) would
 * sit in the Map forever — a slow, in-memory-only leak of one timestamp per ever-deleted batch. Call
 * sites of `deleteFurnaceBatch` (routes/furnace.ts, mcp-server.ts) invoke this right after a successful
 * delete, mirroring the existing `clearTakeoverTracking` cleanup call.
 */
export function evictReconcileReadCache(batchId: string): void {
  reconcileReadAt.delete(batchId);
  reconcileReadInFlight.delete(batchId);
}

/**
 * Sequential batch: stamp the shared batch branch onto every ticket that doesn't already carry it,
 * BEFORE the anchor is dispatched. Because every member then points at the same `task.branch`, the
 * anchor's isolated spawn CREATES the branch + the one shared worktree, and each follower's spawn
 * resolves the SAME worktree by branch — one branch, one worktree slot, one PR. Idempotent + best-effort.
 */
async function ensureBatchBranchAssigned(batchId: string): Promise<void> {
  const batch = getFurnaceBatch(batchId);
  if (!batch || batch.kind !== 'sequential') return;
  const branch = batch.branch;
  for (const member of batch.tickets) {
    const t = tasksCache[member.ticketId];
    if (!t || t.branch === branch) continue;
    if (t.branch && t.branch !== branch) {
      log.warn(`[furnace] ${member.ticketId} already on branch ${t.branch}; not reassigning to batch branch ${branch}`);
      continue;
    }
    try {
      await updateTaskWithHistory(member.ticketId, { extraFields: { branch }, updatedBy: 'Furnace' });
      t.branch = branch;
    } catch (e: unknown) {
      log.warn(`[furnace] assign batch branch ${branch} to ${member.ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** feedCoal path: mark a ticket in-flight with its session in one write (dispatch already succeeded). */
async function setInFlight(
  batchId: string,
  ticketId: string,
  state: 'implementing' | 'reviewing' | 'reimplementing',
  phase: FurnacePhase,
  sessionId: string,
  opts: { attempt?: number; markStarted?: boolean } = {},
): Promise<void> {
  let orphaned = false;
  await mutateFurnaceBatch(batchId, (b) => {
    const t = findTicket(b, ticketId);
    if (!t) { orphaned = true; return; }
    t.state = state;
    t.currentPhase = phase;
    t.currentSessionId = sessionId;
    if (!t.sessionIds.includes(sessionId)) t.sessionIds.push(sessionId);
    t.sessionStartedAt = nowIso();
    t.spawnFailures = 0;
    if (opts.attempt !== undefined) t.attempts = opts.attempt;
    if (opts.markStarted && !t.startedAt) t.startedAt = nowIso();
  });
  // FLUX-1095 (defense in depth): the ticket vanished from the batch between the spawn and this write —
  // e.g. removed via `furnace_ticket action:"remove"` while still `queued` (dispatching guard notwithstanding,
  // in case of a gap elsewhere). No batch owns it, so nothing else would ever stop or account for this
  // session — stop it now rather than leak it (and its worktree slot) forever.
  if (orphaned) {
    log.warn(`[furnace] ${ticketId} vanished from batch ${batchId} mid-spawn — stopping orphaned session ${sessionId}.`);
    try { stopAllSessionsForTask(ticketId, 'furnace ticket removed from batch mid-spawn'); } catch { /* best effort */ }
  }
}

/**
 * Advance a ticket to its next in-flight state BEFORE spawning, clearing the prior (now-terminal)
 * session id. Closes the double-spawn window across a crash.
 */
export async function advanceState(
  batchId: string,
  ticketId: string,
  state: 'reviewing' | 'reimplementing',
  attempt?: number,
): Promise<void> {
  await mutateFurnaceBatch(batchId, (b) => {
    const t = findTicket(b, ticketId);
    if (!t) return;
    t.state = state;
    t.currentPhase = state === 'reviewing' ? 'review' : 'implementation';
    if (attempt !== undefined) t.attempts = attempt;
    delete t.currentSessionId;
    delete t.sessionStartedAt;
    clearCooldownState(t); // FLUX-1063: forward progress ends any prior rate-limit cooldown episode.
  });
}

/**
 * FLUX-1063: clear a ticket's rate-limit cooldown bookkeeping. Called when the ticket makes real forward
 * progress (a session completed and it advanced phase / opened a PR), so a LATER unrelated rate limit
 * starts a fresh cooldown clock rather than inheriting a stale `rateLimitFirstSeenAt`.
 */
function clearCooldownState(t: BatchTicket): void {
  delete t.rateLimitFirstSeenAt;
  delete t.rateLimitAttempts;
  delete t.nextRetryAt;
  delete t.preCooldownState;
}

/**
 * FLUX-1090/1095: settle a ticket as human-owned — mark it `owner: human` and, if it was active/cooling,
 * park it as a settled row (no failure class) so it doesn't sit `implementing`/`reviewing` forever under
 * a human's ownership (which would reject hand-back with "still burning" even though the Furnace already
 * yielded it). Shared by an EXPLICIT takeover (`takeoverTicket`) and `reconcileBatch`'s auto-detected
 * takeover — both settle identically; only who stops the live session differs (the explicit path stops
 * the Furnace's own session, the auto-detected path leaves the human's session alone).
 */
function settleAsHumanOwned(t: BatchTicket): void {
  t.owner = 'human';
  t.note = 'taken over — you are driving this ticket';
  if (isActiveTicketState(t.state) || t.state === 'cooling-down') {
    t.state = 'parked';
    delete t.failureClass;
    delete t.currentSessionId;
    delete t.currentPhase;
    clearCooldownState(t);
  }
}

/** Record a freshly-spawned session id onto a ticket already in its target state; reset spawn failures. */
async function recordSession(batchId: string, ticketId: string, sessionId: string): Promise<void> {
  await mutateFurnaceBatch(batchId, (b) => {
    const t = findTicket(b, ticketId);
    if (!t) return;
    t.currentSessionId = sessionId;
    if (!t.sessionIds.includes(sessionId)) t.sessionIds.push(sessionId);
    t.sessionStartedAt = nowIso();
    t.spawnFailures = 0;
  });
}

/**
 * Park a ticket for a human and record it terminal; bumps the batch's consecutive-failure counter.
 * FLUX-1066: `failureClass` classifies WHY — `needs-input` rests in `parked` (a legit Require Input);
 * `hard-fail` rests in `failed` (a bad state, offer Retry/Take over/Dismiss). Both raise the board flag.
 * A ticket a human has already taken over is NOT parked — the Furnace has yielded it.
 */
async function parkTicket(batchId: string, ticketId: string, reason: string, failureClass: FailureClass = 'hard-fail'): Promise<void> {
  const pre = getFurnaceBatch(batchId);
  const preT = pre ? findTicket(pre, ticketId) : undefined;
  if (preT && isHumanOwned(preT)) return; // yielded to a human — don't park under them.
  await parkTicketOnBoard(ticketId, reason);
  await mutateFurnaceBatch(batchId, (b) => {
    const t = findTicket(b, ticketId);
    if (t) {
      t.state = failureClass === 'needs-input' ? 'parked' : 'failed';
      t.failureClass = failureClass;
      t.note = reason;
      t.endedAt = nowIso();
      delete t.currentSessionId;
      delete t.currentPhase;
      clearCooldownState(t); // FLUX-1063: a ceiling-parked ticket must not keep a stale nextRetryAt/clock.
    }
    // FLUX-1066 (M4): only a hard-fail feeds the circuit breaker. A needs-input park is a legitimate human
    // question — a run of them must NOT trip the "environment may be broken" breaker and halt the batch.
    if (countsTowardBreaker(failureClass)) b.consecutiveFailures = (b.consecutiveFailures || 0) + 1;

    // Sequential batch: a shared branch means a broken member poisons the base for everyone after it.
    // Halt the rest of THIS batch — skip its still-queued tickets — rather than stack on a broken base.
    if (b.kind === 'sequential') {
      for (const m of b.tickets) {
        if (m.ticketId !== ticketId && m.state === 'queued') {
          m.state = 'skipped';
          m.note = `batch halted — sibling ${ticketId} parked (${reason})`;
          m.endedAt = nowIso();
        }
      }
    }
  });
  log.info(`[furnace] ${ticketId} parked: ${reason}`);
}

/**
 * Spawn a phase session for a ticket, counting consecutive failures. On success returns the session id;
 * on failure it increments `spawnFailures` and, once past MAX_SPAWN_ATTEMPTS, PARKS the ticket so a
 * broken environment can never wedge the batch non-terminal.
 */
async function spawnOrCount(
  batchId: string,
  ticketId: string,
  phase: FurnacePhase,
  opts: { personaId?: string; focusComment?: string } = {},
): Promise<{ sid: string | null; parked: boolean }> {
  const batch0 = getFurnaceBatch(batchId);
  const t0 = batch0 ? findTicket(batch0, ticketId) : undefined;
  const skipIsolation = !!(batch0 && t0 && isSequentialFollower(batch0, t0));
  const sid = await dispatchSession(ticketId, phase, { ...opts, ...(skipIsolation ? { skipIsolation: true } : {}) });
  if (sid) return { sid, parked: false };
  await mutateFurnaceBatch(batchId, (b) => {
    const t = findTicket(b, ticketId);
    if (t) t.spawnFailures = (t.spawnFailures || 0) + 1;
  });
  const batch = getFurnaceBatch(batchId);
  const t = batch ? findTicket(batch, ticketId) : undefined;
  if (t && (t.spawnFailures || 0) >= MAX_SPAWN_ATTEMPTS) {
    await parkTicket(batchId, ticketId, `could not start a ${phase} session after ${MAX_SPAWN_ATTEMPTS} attempts (the environment may be broken)`, 'hard-fail');
    return { sid: null, parked: true };
  }
  return { sid: null, parked: false };
}

/** Add or update a PR entry on the batch (dedup: sequential by branch, parallel by ticketId). */
function upsertBatchPr(batch: FurnaceBatch, pr: { url?: string; branch: string; ticketId?: string; reviewState?: BatchPrReviewState }): void {
  if (!pr.url) return;
  const key = batch.kind === 'sequential' ? (p: BatchPr) => p.branch === pr.branch : (p: BatchPr) => p.ticketId === pr.ticketId;
  const existing = batch.prs.find(key);
  if (existing) {
    existing.url = pr.url;
    existing.branch = pr.branch;
    if (pr.ticketId) existing.ticketId = pr.ticketId;
    if (pr.reviewState) existing.reviewState = pr.reviewState;
  } else {
    const entry: BatchPr = { url: pr.url, branch: pr.branch, reviewState: pr.reviewState ?? 'pending' };
    if (pr.ticketId) entry.ticketId = pr.ticketId;
    batch.prs.push(entry);
  }
}

/** Execute a ticket action (spawn / park / mark). Mutations go through the store's per-batch lock. */
async function advanceTicket(batchId: string, ticketId: string, action: TicketAction): Promise<void> {
  switch (action.type) {
    case 'wait':
      return;

    case 'review': {
      const batch = getFurnaceBatch(batchId);
      if (!batch) return;
      await advanceState(batchId, ticketId, 'reviewing');
      await clearReviewState(ticketId);
      // FLUX-1078: a fresh review pass gets a fresh nudge budget.
      await mutateFurnaceBatch(batchId, (b) => {
        const t = findTicket(b, ticketId);
        if (t) t.reviewNudgeSent = false;
      });
      const r = await spawnOrCount(batchId, ticketId, 'review', reviewDispatchOpts(batch));
      if (r.sid) await recordSession(batchId, ticketId, r.sid);
      break;
    }

    case 'review-nudge': {
      const batch = getFurnaceBatch(batchId);
      if (!batch) return;
      await mutateFurnaceBatch(batchId, (b) => {
        const t = findTicket(b, ticketId);
        if (t) t.reviewNudgeSent = true;
      });
      const r = await spawnOrCount(batchId, ticketId, 'review', {
        ...(batch.reviewPersonaId ? { personaId: batch.reviewPersonaId } : {}),
        focusComment: REVIEW_NUDGE_FOCUS,
      });
      if (r.sid) await recordSession(batchId, ticketId, r.sid);
      log.info(`[furnace] ${ticketId} review completed with reviewState unset but a verdict-shaped comment — nudging for the explicit change_status call instead of parking.`);
      break;
    }

    case 'reimplement': {
      await advanceState(batchId, ticketId, 'reimplementing', action.attempt);
      const r = await spawnOrCount(batchId, ticketId, 'implementation', {
        focusComment: REIMPLEMENT_FOCUS,
      });
      if (r.sid) await recordSession(batchId, ticketId, r.sid);
      break;
    }

    case 'pr-open': {
      await mutateFurnaceBatch(batchId, (b) => {
        const t = findTicket(b, ticketId);
        if (t) {
          t.state = 'pr-open';
          if (action.prUrl) t.prUrl = action.prUrl;
          t.lastReviewState = 'approved';
          t.endedAt = nowIso();
          delete t.currentSessionId;
          delete t.currentPhase;
          clearCooldownState(t); // FLUX-1063
          const prBranch = b.kind === 'sequential' ? b.branch : (tasksCache[ticketId]?.branch || b.branch);
          upsertBatchPr(b, { ...(action.prUrl ? { url: action.prUrl } : {}), branch: prBranch, ticketId, reviewState: 'approved' });
        }
        b.consecutiveFailures = 0; // a success breaks the failure streak (circuit breaker)
      });
      log.info(`[furnace] ${ticketId} approved — PR left open at Ready (not merged).`);
      break;
    }

    case 'park': {
      await parkTicket(batchId, ticketId, action.reason, action.failureClass);
      break;
    }

    case 'redrive': {
      const batch = getFurnaceBatch(batchId);
      if (!batch) return;
      const opts = action.phase === 'review' ? reviewDispatchOpts(batch) : {};
      const r = await spawnOrCount(batchId, ticketId, action.phase, opts);
      if (r.sid) await recordSession(batchId, ticketId, r.sid);
      break;
    }

    case 'retry-exhausted': {
      const batch = getFurnaceBatch(batchId);
      if (!batch) return;
      await mutateFurnaceBatch(batchId, (b) => {
        const t = findTicket(b, ticketId);
        if (!t) return;
        t.exhaustionAttempts = action.attempt;
        delete t.currentSessionId;
        delete t.sessionStartedAt;
      });
      try { stopAllSessionsForTask(ticketId, 'furnace retrying context-exhausted ticket'); } catch { /* best effort */ }
      const opts = action.phase === 'review' ? reviewDispatchOpts(batch) : {};
      const r = await spawnOrCount(batchId, ticketId, action.phase, opts);
      if (r.sid) await recordSession(batchId, ticketId, r.sid);
      log.info(`[furnace] ${ticketId} ${action.phase} session ran out of context — retrying with a fresh session (attempt ${action.attempt}/${batch.exhaustionRetryCap}).`);
      break;
    }

    case 'cooldown-rate-limited': {
      const batch = getFurnaceBatch(batchId);
      if (!batch) return;
      const intervalMs = batch.rateLimitRetryIntervalMs ?? DEFAULT_RATE_LIMIT_RETRY_INTERVAL_MS;
      const nextRetryAt = new Date(Date.now() + intervalMs).toISOString();
      let firstEntry = false;
      await mutateFurnaceBatch(batchId, (b) => {
        const t = findTicket(b, ticketId);
        if (!t) return;
        // Start the ceiling clock only on the FIRST entry of this cooldown episode; preserve it across
        // the interim retries so the `rateLimitMaxWaitMs` ceiling measures the whole episode.
        if (!t.rateLimitFirstSeenAt) { t.rateLimitFirstSeenAt = nowIso(); firstEntry = true; }
        // Remember the active state to restore when the retry fires (impl / review / re-impl).
        if (isActiveTicketState(t.state)) t.preCooldownState = t.state;
        t.nextRetryAt = nextRetryAt;
        t.state = 'cooling-down';
        t.note = `rate-limited — cooling down, next retry ${nextRetryAt}`;
        delete t.currentSessionId;
        delete t.sessionStartedAt;
        // Deliberately does NOT touch attempts / exhaustionAttempts / consecutiveFailures.
      });
      try { stopAllSessionsForTask(ticketId, 'furnace cooling down (rate-limited)'); } catch { /* best effort */ }
      if (firstEntry) await noteCooldownOnBoard(ticketId, nextRetryAt, batch);
      log.info(`[furnace] ${ticketId} rate-limited — cooling down, next retry ~${nextRetryAt} (ceiling ${Math.round((batch.rateLimitMaxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS) / 3_600_000)}h).`);
      break;
    }

    case 'retry-rate-limited': {
      const batch = getFurnaceBatch(batchId);
      if (!batch) return;
      // Restore the active state we were in before cooling down, then spawn a FRESH session (no --resume).
      const prior = findTicket(batch, ticketId)?.preCooldownState;
      const restored: 'implementing' | 'reviewing' | 'reimplementing' =
        prior === 'reviewing' || prior === 'reimplementing' ? prior : 'implementing';
      await mutateFurnaceBatch(batchId, (b) => {
        const t = findTicket(b, ticketId);
        if (!t) return;
        t.state = restored;
        t.currentPhase = phaseForState(restored); // derive from the restored state so state/phase can't drift
        t.rateLimitAttempts = action.attempt;
        delete t.currentSessionId;
        delete t.sessionStartedAt;
        // Keep rateLimitFirstSeenAt (ceiling clock) + preCooldownState — cleared only on real progress.
      });
      try { stopAllSessionsForTask(ticketId, 'furnace retrying rate-limited ticket'); } catch { /* best effort */ }
      // Re-supply the re-implementation focus if we were mid-reimplement; else the phase's reviewer persona.
      const opts = restored === 'reimplementing'
        ? { focusComment: REIMPLEMENT_FOCUS }
        : action.phase === 'review' ? reviewDispatchOpts(batch) : {};
      const r = await spawnOrCount(batchId, ticketId, action.phase, opts);
      if (r.sid) await recordSession(batchId, ticketId, r.sid);
      log.info(`[furnace] ${ticketId} rate-limit cooldown elapsed — retrying ${action.phase} with a fresh session (attempt ${action.attempt}).`);
      break;
    }
  }
}

/**
 * FLUX-1063: surface a rate-limit cooldown on the board ticket — DISTINCT from a park. A park raises the
 * `require-input` swimlane and needs a human; a cooldown is just waiting, so this only appends an activity
 * note (no status change, no swimlane) so a human watching the ticket sees why it went quiet. Best-effort.
 */
async function noteCooldownOnBoard(ticketId: string, nextRetryAt: string, batch: FurnaceBatch): Promise<void> {
  const hrs = Math.round((batch.rateLimitMaxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS) / 3_600_000);
  try {
    await updateTaskWithHistory(ticketId, {
      entries: [{
        type: 'comment',
        user: 'Furnace',
        comment: `Rate-limited — cooling down (not parked). Auto-retrying every ${Math.round((batch.rateLimitRetryIntervalMs ?? DEFAULT_RATE_LIMIT_RETRY_INTERVAL_MS) / 60_000)}m, next retry ${nextRetryAt}, up to a ${hrs}h ceiling before failing outright.`,
        date: nowIso(),
      }],
      updatedBy: 'Furnace',
    });
  } catch (e: unknown) {
    log.warn(`[furnace] cooldown note on ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Observe one active ticket's session and advance it. Re-reads the ticket fresh from the store. */
async function reconcileTicket(batchId: string, ticketId: string): Promise<void> {
  const batch0 = getFurnaceBatch(batchId);
  const ticket = batch0 ? findTicket(batch0, ticketId) : undefined;
  if (!ticket || !isActiveTicketState(ticket.state)) return;
  if (isHumanOwned(ticket)) return; // FLUX-1066: the Furnace has yielded this ticket to a human.

  const currentPhase: FurnacePhase = ticket.state === 'reviewing' ? 'review' : 'implementation';
  let sess = ticket.currentSessionId ? cliSessionsById.get(ticket.currentSessionId) : undefined;
  if (!sess) sess = activeSessionForPhase(ticketId, currentPhase);
  if (sess && sess.id !== ticket.currentSessionId) {
    const adoptedId = sess.id;
    await mutateFurnaceBatch(batchId, (b) => {
      const t = findTicket(b, ticketId);
      if (t) {
        t.currentSessionId = adoptedId;
        if (!t.sessionIds.includes(adoptedId)) t.sessionIds.push(adoptedId);
        if (!t.sessionStartedAt) t.sessionStartedAt = nowIso();
      }
    });
  }

  const task = tasksCache[ticketId];
  const batch = getFurnaceBatch(batchId);
  if (!batch) return;
  const prUrl = extractPrUrl(task);
  const sessionOutcome = findSessionOutcome(task, sess?.id ?? ticket.currentSessionId);
  const action = decideTicketAction({
    ticket,
    ...(sess ? { sessionStatus: sess.status } : {}),
    ...(sess?.terminalReason ? { terminalReason: sess.terminalReason } : {}),
    ...(sessionOutcome ? { sessionOutcome } : {}),
    reviewState: task?.reviewState ?? null,
    ...(task?.status ? { ticketStatus: task.status } : {}),
    ...(configCache.requireInputStatus ? { requireInputStatus: configCache.requireInputStatus } : {}),
    retryCap: batch.retryCap,
    exhaustionRetryCap: batch.exhaustionRetryCap,
    ...(prUrl !== undefined ? { prUrl } : {}),
    // FLUX-1080: scoped to comments posted during THIS review pass — a stale prior-round verdict-shaped
    // comment must not be mistaken for this round's, or the review-nudge could record a false verdict.
    reviewVerdictMarkerSeen: lastCommentMatchesVerdictMarker(task?.history, ticket.sessionStartedAt),
  });
  // FLUX-1033: mirror the reviewer's verdict onto the real GitHub PR (before advanceTicket transitions
  // the ticket out of `reviewing`, so it fires exactly once per verdict). Best-effort.
  await mirrorReviewVerdictToPr(batch, action, ticketId, ticket, task?.reviewState ?? null, prUrl);
  await advanceTicket(batchId, ticketId, action);
}

/**
 * FLUX-1063: advance one ticket that is in the `cooling-down` state (rate-limit cooldown). Unlike
 * `reconcileTicket` there's no live session to observe — the decision is purely time-based (keep waiting,
 * fire the retry, or give up at the ceiling), so this routes straight through the pure decision core.
 */
async function reconcileCooldown(batchId: string, ticketId: string, nowMs: number): Promise<void> {
  const batch = getFurnaceBatch(batchId);
  const ticket = batch ? findTicket(batch, ticketId) : undefined;
  if (!batch || !ticket || ticket.state !== 'cooling-down') return;
  const action = decideTicketAction({
    ticket,
    retryCap: batch.retryCap,
    nowMs,
    rateLimitRetryIntervalMs: batch.rateLimitRetryIntervalMs,
    rateLimitMaxWaitMs: batch.rateLimitMaxWaitMs,
  });
  await advanceTicket(batchId, ticketId, action);
}

/**
 * Decide what review to mirror onto the real GitHub PR (FLUX-1033). Group-aware for sequential batches:
 * a sequential batch shares ONE PR that keeps accumulating commits until its LAST ticket finishes, so a
 * real `--approve` fires only on the final ticket AND once every ticket is approved — earlier approvals
 * post a COMMENT instead. Parallel = 1 ticket = 1 PR, so a per-ticket approve is already correct.
 */
export function pickPrReview(
  batch: FurnaceBatch,
  ticket: BatchTicket,
  action: TicketAction,
  reviewState: 'approved' | 'changes-requested' | null,
): { verdict: 'approved' | 'changes-requested'; commentOnly: boolean } | null {
  if (action.type === 'pr-open') {
    const shared = batch.kind === 'sequential';
    return { verdict: 'approved', commentOnly: shared && !isFinalSequentialApproval(batch, ticket) };
  }
  if (ticket.state === 'reviewing' && reviewState === 'changes-requested'
      && (action.type === 'reimplement' || action.type === 'park')) {
    return { verdict: 'changes-requested', commentOnly: false };
  }
  return null;
}

/**
 * True when `ticket` is being approved as the FINAL approval of its sequential batch: it is the
 * highest-order ticket AND every other ticket already carries an approved verdict (is at `pr-open`).
 */
function isFinalSequentialApproval(batch: FurnaceBatch, ticket: BatchTicket): boolean {
  const members = [...batch.tickets].sort((a, b) => a.order - b.order);
  const last = members[members.length - 1];
  if (!last || last.ticketId !== ticket.ticketId) return false;
  return members.every((m) => m.ticketId === ticket.ticketId || m.lastReviewState === 'approved');
}

/** Post the reviewer's verdict onto the real GitHub PR (best-effort), and reflect it on `batch.prs`. */
export async function mirrorReviewVerdictToPr(
  batch: FurnaceBatch,
  action: TicketAction,
  ticketId: string,
  ticket: BatchTicket,
  reviewState: 'approved' | 'changes-requested' | null,
  prUrl: string | undefined,
): Promise<void> {
  if (!prUrl) return;
  const pick = pickPrReview(batch, ticket, action, reviewState);
  if (!pick) return;
  const { verdict, commentOnly } = pick;

  // Reflect the verdict on the batch's PR list (changes-requested here; approved is set in the pr-open path).
  if (verdict === 'changes-requested') {
    await mutateFurnaceBatch(batch.id, (b) => {
      const prBranch = b.kind === 'sequential' ? b.branch : (tasksCache[ticketId]?.branch || b.branch);
      upsertBatchPr(b, { url: prUrl, branch: prBranch, ticketId, reviewState: 'changes_requested' });
    });
  }

  const body = commentOnly
    ? `✅ Ticket ${ticketId} approved by the EventHorizon Furnace review — this shared batch PR is formally approved only once its final ticket is approved. See the ticket's review comment for details.`
    : verdict === 'approved'
      ? `✅ Approved by the EventHorizon Furnace review (${ticketId}). See the ticket's review comment for details.`
      : `🔁 Changes requested by the EventHorizon Furnace review (${ticketId}). See the ticket's review comment for details.`;
  try {
    const outcome = await postPrReview(prUrl, verdict, body, { commentOnly });
    log.info(`[furnace] ${ticketId} PR review posted (${verdict}${commentOnly ? ', comment-only' : ''} → ${outcome}).`);
  } catch (e: unknown) {
    log.warn(`[furnace] ${ticketId} mirror review verdict to PR failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A human-facing warning when a requested burn rate exceeds the cap (it will be clamped), else undefined. */
export function burnRateClampWarning(burnRate: number | undefined): string | undefined {
  if (burnRate !== undefined && burnRate > MAX_BURN_RATE) {
    return `burn rate ${burnRate} exceeds the max ${MAX_BURN_RATE} — it will be clamped to ${MAX_BURN_RATE}.`;
  }
  return undefined;
}

// ── Watchdog / circuit breaker ─────────────────────────────────────────────────

/** Pure: has this ticket's current session outlived the per-session watchdog timeout? */
export function isSessionTimedOut(ticket: BatchTicket, timeoutMs: number | undefined, nowMs: number): boolean {
  if (!timeoutMs || timeoutMs <= 0) return false;
  if (!isActiveTicketState(ticket.state) || !ticket.sessionStartedAt) return false;
  const started = Date.parse(ticket.sessionStartedAt);
  if (Number.isNaN(started)) return false;
  return nowMs - started > timeoutMs;
}

/** Per-session watchdog: kill + park any ticket whose session outlived the timeout (per-ticket; batch continues). */
async function runWatchdog(batchId: string, nowMs: number): Promise<void> {
  const batch = getFurnaceBatch(batchId);
  if (!batch) return;
  const timeoutMs = batch.sessionTimeoutMs;
  const timedOut = batch.tickets.filter((t) => isSessionTimedOut(t, timeoutMs, nowMs)).map((t) => t.ticketId);
  for (const ticketId of timedOut) {
    const mins = Math.round((timeoutMs || 0) / 60000);
    await parkTicket(batchId, ticketId, `session exceeded the ${mins}m watchdog timeout and was killed`, 'hard-fail');
  }
}

/** True when the batch's circuit breaker has tripped. */
export function breakerTripped(batch: FurnaceBatch): boolean {
  return (batch.consecutiveFailures || 0) >= batch.maxConsecutiveFailures;
}

/**
 * FLUX-1066 (M4): does a park of this failure class count toward the circuit breaker? Only `hard-fail`
 * (a crash/cancel, no-verdict, watchdog timeout, spawn failure, or a rate-limit ceiling breach — signals a
 * broken environment) does. A `needs-input` park is a legitimate human question, so a streak of them must
 * never trip the breaker. (`transient`/`recoverable` never reach a park — they're handled in-flight.)
 */
export function countsTowardBreaker(failureClass: FailureClass): boolean {
  return failureClass === 'hard-fail';
}

// ── Finalization ───────────────────────────────────────────────────────────────

/**
 * The single terminal funnel: stamp the terminal status + report, then fire the summary notification.
 * `parked` when the batch halted with work remaining (breaker/hard-stop), else `done`.
 */
async function finalizeBatch(batchId: string, status: 'done' | 'parked'): Promise<void> {
  const now = nowIso();
  const updated = await mutateFurnaceBatch(batchId, (b) => {
    b.status = status;
    if (!b.completedAt) b.completedAt = now;
    b.report = assembleBurnReport(b, now);
  });
  if (!updated) return;
  const rep = updated.report;
  log.info(`[furnace] batch ${batchId} ${status} — ${rep?.prsOpened.length ?? 0} PR(s) open, ${rep?.parked.length ?? 0} parked.`);
  emitBurnReportNotification(updated);
}

function emitBurnReportNotification(batch: FurnaceBatch): void {
  const r = batch.report;
  if (!r) return;
  const bits = [`${r.prsOpened.length} PR(s) ready`, `${r.parked.length} parked`];
  if (r.failed.length) bits.push(`${r.failed.length} failed`);
  const title = `Furnace batch "${batch.title}" ${batch.status === 'parked' ? 'halted' : 'finished'} — ${r.prsOpened.length} PR(s) ready`;
  const message = [
    `${r.processed} ticket(s) processed: ${bits.join(', ')}.`,
    r.stopReason ? `Stopped: ${r.stopReason}.` : '',
    r.nextActions && r.nextActions.length ? `Next: ${r.nextActions.join(' ')}` : '',
  ].filter(Boolean).join(' ');
  try {
    addNotification({ type: 'completion', title, message, actions: [] });
  } catch (e: unknown) {
    log.warn(`[furnace] burn-report notification failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Hard cutoff: kill in-flight sessions, park those tickets, skip queued ones, → parked + report. */
async function haltBatch(batchId: string, reason: string): Promise<void> {
  const batch = getFurnaceBatch(batchId);
  if (!batch) return;
  // FLUX-1063: a cooling-down ticket (rate-limit wait) has real work in flight — park it like an active
  // one on a hard halt rather than silently abandoning its cooldown.
  const activeIds = batch.tickets
    .filter((t) => (isActiveTicketState(t.state) || t.state === 'cooling-down') && !isHumanOwned(t))
    .map((t) => t.ticketId);
  for (const ticketId of activeIds) await parkTicket(batchId, ticketId, `batch halted (${reason})`, 'hard-fail');
  await mutateFurnaceBatch(batchId, (b) => {
    for (const t of b.tickets) {
      if (t.state === 'queued') { t.state = 'skipped'; t.note = 'batch halted before this ticket started'; }
    }
    if (!b.stopReason) b.stopReason = reason;
  });
  log.info(`[furnace] batch ${batchId} HALTED: ${reason}`);
  await finalizeBatch(batchId, 'parked');
}

/** Soft-stop drain complete: skip any never-started tickets, then → done + report. */
async function finalizeStop(batchId: string): Promise<void> {
  await mutateFurnaceBatch(batchId, (b) => {
    for (const t of b.tickets) {
      if (t.state === 'queued') { t.state = 'skipped'; t.note = 'not started before the batch stopped'; }
      // FLUX-1063: a graceful stop must not block up to the multi-hour rate-limit ceiling — a still
      // cooling-down ticket is skipped (its cooldown never got to retry before the batch drained).
      else if (t.state === 'cooling-down') { t.state = 'skipped'; t.note = 'rate-limit cooldown not retried before the batch stopped'; }
    }
  });
  await finalizeBatch(batchId, 'done');
}

/** Start queued tickets up to the batch's burn rate AND the global worktree-slot cap. */
async function feedCoal(batchId: string): Promise<void> {
  for (;;) {
    const batch = getFurnaceBatch(batchId);
    if (!batch || batch.status !== 'burning') return;
    // FLUX-1063: usage/quota is account-wide — while any ticket in this batch is cooling down after a
    // rate limit, a freshly-spawned sibling would immediately 429 into the same limit. Pause feeding new
    // coal until the cooldown resolves (in-flight tickets are left to drain).
    if (batch.tickets.some((t) => t.state === 'cooling-down')) return;
    if (activeTicketCount(batch) >= effectiveConcurrency(batch)) return;
    // Parallel batches consume a fresh worktree slot per burning ticket — respect the global cap.
    // Sequential batches already hold their single reserved slot for the whole burn.
    if (batch.kind === 'parallel' && freeSlots() < 1) return;
    const next = nextQueuedTicket(batch);
    if (!next) return;

    if (batch.kind === 'sequential') await ensureBatchBranchAssigned(batchId);

    // FLUX-1090: the ticket is still `queued` (not yet `isActiveTicketState`) until `setInFlight` below
    // records the new session, but that session is live from the moment it's dispatched/adopted — mark it
    // `dispatching` for that whole window so a concurrent `reconcileBatch` (every tick AND every
    // furnace_get/GET) can't mistake the Furnace's own in-flight spawn for a human takeover.
    dispatching.add(next.ticketId);
    try {
      // Crash-safety: adopt an already-running impl session (a pre-crash spawn we never recorded).
      const existing = activeSessionForPhase(next.ticketId, 'implementation');
      if (existing) {
        await setInFlight(batchId, next.ticketId, 'implementing', 'implementation', existing.id, { markStarted: true });
        continue;
      }
      const r = await spawnOrCount(batchId, next.ticketId, 'implementation', {});
      if (r.sid) {
        await setInFlight(batchId, next.ticketId, 'implementing', 'implementation', r.sid, { markStarted: true });
        continue;
      }
      if (r.parked) continue; // exhausted spawn attempts → parked; try the next queued ticket
      return;                 // transient spawn failure — stop feeding this tick, retry next
    } finally {
      dispatching.delete(next.ticketId);
    }
  }
}

// ── Worktree-pool reconciliation (FLUX-1067) ────────────────────────────────────

// FLUX-1069: every Furnace read path (GET /, GET /slots, GET /:id, furnace_get, plus the 5s drive-cycle
// tick) calls refreshWorktreePool() independently, so a single portal poll round-trip (the drawer fires
// two of those reads via Promise.all) shells out to `git worktree list` twice for the same observed
// state. Coalesce: concurrent callers share one in-flight call, and a call landing within the TTL of the
// last completed one is skipped outright (the observed pool is still fresh).
const WORKTREE_POOL_TTL_MS = 1_500;
let worktreePoolInFlight: Promise<void> | null = null;
let worktreePoolRefreshedAt = 0;

/**
 * Observe the ACTUAL live task-worktree pool and feed the count to the slot accounting, so the gauge and
 * the ignite/burn-rate clamp reflect reality — including worktrees live for reasons the Furnace isn't
 * tracking (a manually resumed/driven session, a taken-over parked ticket). Best-effort: on any failure
 * (git error, no workspace) it keeps the last known count rather than falsely zeroing the pool.
 *
 * `opts.force` bypasses the freshness-window skip (FLUX-1157): igniting/resuming a batch reclaims stale
 * worktrees right beforehand (see `igniteBatch`), and the whole point of that reclaim is to shrink the
 * physical pool this function observes — a coalesced read landing inside the TTL would report the
 * pre-reclaim count and refuse the ignite anyway.
 *
 * FLUX-1158: `force` must guarantee a `git worktree list` read that starts AFTER reclaim, not just any
 * fresh-enough one. If a non-forced refresh (e.g. the 5s stoker tick) is already in flight when a forced
 * call lands, naively returning that shared in-flight promise (the old single-flight shortcut above)
 * could hand back a read that started BEFORE the reclaim — stale. So a forced call always waits out any
 * in-flight read first, then issues its own — sequenced, not concurrent, so a slow in-flight read can't
 * clobber the forced one's fresher result by finishing later.
 */
export async function refreshWorktreePool(opts: { force?: boolean } = {}): Promise<void> {
  if (worktreePoolInFlight && !opts.force) return worktreePoolInFlight;
  if (!opts.force && Date.now() - worktreePoolRefreshedAt < WORKTREE_POOL_TTL_MS) return;
  if (opts.force && worktreePoolInFlight) await worktreePoolInFlight.catch(() => {});
  worktreePoolInFlight = (async () => {
    try {
      const root = requireWorkspaceRoot();
      const worktrees = await listTaskWorktrees(root);
      // FLUX-1067 (M3): feed the OWNING ticket id of each worktree (recovered from its path), not just a
      // count, so the slot accounting can distinguish a Furnace-backed worktree from an independent one.
      setObservedWorktrees(worktrees.map((w) => ticketIdFromWorktreePath(root, w.path)));
    } catch {
      /* best-effort — keep the last observed pool */
    } finally {
      worktreePoolRefreshedAt = Date.now();
      worktreePoolInFlight = null;
    }
  })();
  return worktreePoolInFlight;
}

/**
 * FLUX-1187: whether at least one `refreshWorktreePool()` pass has completed since boot. Unlike the
 * Furnace batch cache (loaded from disk by `ensureFurnaceLoaded()`), `observedWorktreeCount` has no
 * on-disk source of truth — it starts at 0 and is only populated by an actual `git worktree list` scan.
 * A read route can use this to block on just the very first call (so it never serves a stale/inflated
 * slot count before the pool has been observed even once) while still treating every later call as
 * stale-while-revalidate (fire the refresh in the background, answer from the cache immediately).
 */
export function hasScannedWorktreePool(): boolean {
  return worktreePoolRefreshedAt > 0;
}

/** A ticket currently holding a worktree slot, with why — see {@link describeSlotHolders}. */
export interface FurnaceSlotHolder {
  ticketId: string;
  reason: string;
}

const UNRECLAIMABLE_LABEL: Record<UnreclaimableReason, string> = {
  'unknown-ticket': 'ticket not found on the board',
  'live-session': 'a session is still live on its branch',
  'recent-activity': 'recently active — briefly protected from reclaim',
  status: 'ticket status is not yet reclaimable (not Ready/terminal)',
};

/**
 * Name every ticket currently holding a worktree slot, with why reclaim didn't free it — surfaced on an
 * ignite/resume `no_slots` refusal (FLUX-1157) so the user can act (finish/abandon/take over a specific
 * ticket) instead of guessing which of the capped worktrees to look at. Best-effort: a listing failure
 * yields an empty list rather than blocking the refusal response itself.
 */
export async function describeSlotHolders(workspaceRoot: string): Promise<FurnaceSlotHolder[]> {
  const burning = new Set(getBurningBatches().flatMap((b) => furnaceReservedTicketIds(b)));
  const worktrees = await listTaskWorktrees(workspaceRoot).catch(() => []);
  const holders: FurnaceSlotHolder[] = [];
  const seen = new Set<string>();
  for (const wt of worktrees) {
    const ticketId = ticketIdFromWorktreePath(workspaceRoot, wt.path);
    if (!ticketId) continue;
    seen.add(ticketId);
    if (burning.has(ticketId)) { holders.push({ ticketId, reason: 'actively burning' }); continue; }
    const unreclaimable = worktreeUnreclaimableReason(ticketId);
    if (unreclaimable) { holders.push({ ticketId, reason: UNRECLAIMABLE_LABEL[unreclaimable] }); continue; }
    // Reclaimable by status/session, yet still on disk — the only reason reclaimWorktrees would have
    // skipped it is a dirty tree (uncommitted work reclaim never discards).
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: wt.path }).catch(() => ({ stdout: '' }));
    holders.push({
      ticketId,
      reason: stdout.trim().length > 0 ? 'uncommitted changes (dirty tree) — reclaim left it alone' : 'idle — not yet reclaimed',
    });
  }
  // FLUX-1158: a reservation claimed by claimSlotsAndIgnite counts toward globalSlotsInUse the instant a
  // batch flips to `burning` (via furnaceReservedTicketIds), but its worktree may not be materialized on
  // disk yet (several batches igniting back-to-back). Without this, such a reservation is invisible to
  // the loop above — a `no_slots` refusal could name fewer tickets than `used` implies. Name it too.
  for (const ticketId of burning) {
    if (!seen.has(ticketId)) holders.push({ ticketId, reason: 'reserved — worktree not yet created' });
  }
  return holders;
}

// ── Tick orchestration ────────────────────────────────────────────────────────

const ticking = new Set<string>();

/** Advance one batch by a single tick: watchdog, breaker, reconcile in-flight, feed coal, finalize. */
export async function stokerTick(batchId: string): Promise<void> {
  if (ticking.has(batchId)) return; // never overlap ticks for the same batch
  ticking.add(batchId);
  try {
    let batch = getFurnaceBatch(batchId);
    if (!batch || batch.status !== 'burning') return;
    const now = Date.now();

    // A0. Reconcile against ground truth FIRST (FLUX-1066): reflect any ticket completed/taken over
    // outside the Furnace before the Stoker acts on a stale view.
    await reconcileBatch(batchId);
    batch = getFurnaceBatch(batchId);
    if (!batch || batch.status !== 'burning') return;

    // A. Watchdog — kill + park any ticket whose session outlived the timeout (per-ticket).
    await runWatchdog(batchId, now);

    // B. Circuit breaker — a broken environment halts the batch (hard cutoff).
    batch = getFurnaceBatch(batchId);
    if (!batch || batch.status !== 'burning') return;
    if (!batch.stopRequested && breakerTripped(batch)) {
      await haltBatch(batchId, `circuit breaker tripped — ${batch.consecutiveFailures} consecutive failures (the environment may be broken)`);
      return;
    }

    // C. Reconcile every in-flight ticket (always — this is what lets a stopping batch drain).
    batch = getFurnaceBatch(batchId);
    if (!batch) return;
    const activeIds = batch.tickets.filter((t) => isActiveTicketState(t.state)).map((t) => t.ticketId);
    for (const ticketId of activeIds) await reconcileTicket(batchId, ticketId);

    // C2. FLUX-1063: advance rate-limit cooldowns — fire due retries / fail out at the ceiling. Gated
    // on !stopRequested (like feedCoal below): a retry would spawn a FRESH session and re-activate the
    // ticket, which would defeat a requested graceful stop (finalizeStop's noActive check would never
    // pass). While stopping, cooling tickets are left untouched so finalizeStop can skip them to drain.
    batch = getFurnaceBatch(batchId);
    if (!batch) return;
    if (!batch.stopRequested) {
      const coolingIds = batch.tickets.filter((t) => t.state === 'cooling-down').map((t) => t.ticketId);
      for (const ticketId of coolingIds) await reconcileCooldown(batchId, ticketId, now);
    }

    // D. Feed new coal — unless a stop has been requested.
    batch = getFurnaceBatch(batchId);
    if (batch && batch.status === 'burning' && !batch.stopRequested) await feedCoal(batchId);

    // E. Finalize: a drained soft-stop → done; an all-settled batch → done. A human-owned ticket counts
    // as settled (FLUX-1066) so a taken-over ticket can't wedge the batch burning forever.
    batch = getFurnaceBatch(batchId);
    if (batch && batch.status === 'burning') {
      const noActive = !batch.tickets.some((t) => isActiveTicketState(t.state) && !isHumanOwned(t));
      if (batch.stopRequested && noActive) {
        await finalizeStop(batchId);
      } else if (allTicketsSettled(batch)) {
        await finalizeBatch(batchId, 'done');
      }
    }
  } catch (e: unknown) {
    log.error(`[furnace] tick for ${batchId} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ticking.delete(batchId);
  }
}

/** Tick every burning batch, then evaluate triggers for draft batches. */
async function driveBurningBatches(): Promise<void> {
  // FLUX-1067: observe the real worktree pool once per cycle so the slot gauge + ignite clamp are current.
  await refreshWorktreePool();
  for (const batch of getBurningBatches()) {
    await stokerTick(batch.id);
  }
  // FLUX-1066: reconcile TERMINAL batches too (the Stoker doesn't tick them) so a parked/done batch whose
  // ticket a human resumed and completed — or is driving — reflects that instead of staying stuck.
  for (const batch of getFurnaceBatchesCache()) {
    if (isBatchTerminal(batch.status)) await reconcileBatch(batch.id);
  }
  await checkTriggers();
}

// ── Trigger watcher ─────────────────────────────────────────────────────────────

/**
 * True when a draft batch's auto-trigger is satisfied.
 *   type 'batch' — the referenced batch is terminal (done/parked) AND every one of its PRs is `merged`
 *                  (a batch with no PRs counts as satisfied once terminal).
 *   type 'pr'    — a PR anywhere in the Furnace matching `ref` is marked `merged`.
 * Merge state is set out-of-band (portal "Merge" action / external), so this reads persisted `prs`.
 */
export function isTriggerSatisfied(batch: FurnaceBatch): boolean {
  const trig = batch.trigger;
  if (!trig) return false;
  if (trig.type === 'batch') {
    const ref = getFurnaceBatch(trig.ref);
    if (!ref || !isBatchTerminal(ref.status)) return false;
    return ref.prs.every((p) => p.reviewState === 'merged');
  }
  // type 'pr' — match by url or #number across all batches.
  const needle = trig.ref.trim();
  for (const b of getFurnaceBatchesCache()) {
    for (const p of b.prs) {
      const matches = p.url === needle || (p.number !== undefined && `#${p.number}` === needle) || (p.number !== undefined && String(p.number) === needle);
      if (matches && p.reviewState === 'merged') return true;
    }
  }
  return false;
}

let checkingTriggers = false;

/** Evaluate all draft batches with a trigger; auto-ignite any whose trigger is satisfied (slot permitting). */
export async function checkTriggers(): Promise<void> {
  if (checkingTriggers) return;
  checkingTriggers = true;
  try {
    for (const batch of getFurnaceBatchesCache()) {
      if (batch.status !== 'draft' || !batch.trigger) continue;
      if (batch.tickets.length === 0) continue;
      if (!isTriggerSatisfied(batch)) continue;
      if (freeSlots() < 1) continue; // no worktree slot — try again next tick
      const r = await igniteBatch(batch.id);
      if (r.ok) log.info(`[furnace] batch ${batch.id} auto-ignited — trigger ${batch.trigger.type}:${batch.trigger.ref} satisfied.`);
    }
  } catch (e: unknown) {
    log.warn(`[furnace] trigger check failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    checkingTriggers = false;
  }
}

let stokerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the background stoke loop (idempotent). Ticks every burning batch each interval. */
export function startStoker(): void {
  if (stokerTimer) return;
  stokerTimer = setInterval(() => { void driveBurningBatches(); }, STOKE_INTERVAL_MS);
  stokerTimer.unref?.();
  log.info('[furnace] stoker loop started.');
}

export function stopStoker(): void {
  if (stokerTimer) { clearInterval(stokerTimer); stokerTimer = null; }
}

// ── Batch control (ignite / stop) ────────────────────────────────────────────────

export interface BatchControlResult {
  ok: boolean;
  error?: string;
  used?: number;
  max?: number;
  batch?: FurnaceBatch | null;
  /** Named on a `no_slots` refusal (FLUX-1157) — which tickets hold the slots, and why. */
  holders?: FurnaceSlotHolder[];
}

/** Package a failed {@link claimSlotsAndIgnite} result, naming the slot holders when it failed `no_slots`. */
async function claimFailureResult(
  claim: { error?: string; used?: number; max?: number },
  workspaceRoot: string,
): Promise<BatchControlResult> {
  const holders = claim.error === 'no_slots'
    ? await describeSlotHolders(workspaceRoot).catch(() => [] as FurnaceSlotHolder[])
    : [];
  return {
    ok: false,
    ...(claim.error ? { error: claim.error } : {}),
    ...(claim.used !== undefined ? { used: claim.used } : {}),
    ...(claim.max !== undefined ? { max: claim.max } : {}),
    ...(holders.length ? { holders } : {}),
  };
}

/** Ignite a batch: draft -> burning. Claims a worktree slot (409 `no_slots` when full), then kicks a tick. */
export async function igniteBatch(id: string): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(id);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  if (batch.status === 'burning') return { ok: true, batch }; // idempotent
  if (isBatchTerminal(batch.status)) return { ok: false, error: `batch is ${batch.status} — create a new batch` };
  if (batch.tickets.length === 0) return { ok: false, error: 'batch is empty — add tickets first' };

  const root = requireWorkspaceRoot();
  // FLUX-1157: reclaim every worktree that's genuinely safe to release (Ready/terminal ticket, no live
  // session, clean tree) BEFORE recounting. FLUX-1090 discounted a terminal-batch ticket's worktree from
  // the gauge on the assumption it was reclaimed — it wasn't (takeover semantics never delete it), which
  // let the gauge report a free slot the physical cap (createTaskWorktree) didn't actually have. Actually
  // reclaiming it here means the slot is REALLY free, not just uncounted.
  await reclaimReadyWorktrees(root).catch(() => [] as string[]);
  // FLUX-1067: reconcile the slot count against the real worktree pool BEFORE the atomic claim, so we
  // never over-spawn past worktrees that are live for reasons the Furnace isn't tracking. `force` because
  // the reclaim above may have just shrunk the physical pool the last refresh cached.
  await refreshWorktreePool({ force: true });
  const claim = await claimSlotsAndIgnite(id, nowIso(), FURNACE_SLOT_CAP);
  if (!claim.ok) return claimFailureResult(claim, root);
  void stokerTick(id); // don't wait for the next interval
  log.info(`[furnace] batch ${id} ignited (${batch.tickets.length} ticket(s), ${batch.kind}, burn rate ${claim.batch?.burnRate}).`);
  return { ok: true, batch: claim.batch ?? null };
}

/**
 * Stop a batch. Default is a GRACEFUL stop: request a drain — stop feeding, let in-flight tickets reach
 * a terminal state, then finalize. `hard: true` (or a non-burning batch) is an immediate cutoff.
 */
export async function stopBatch(id: string, reason = 'manual stop', opts: { hard?: boolean } = {}): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(id);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  if (isBatchTerminal(batch.status)) return { ok: true, batch };
  if (opts.hard || batch.status !== 'burning') {
    await haltBatch(id, reason);
    return { ok: true, batch: getFurnaceBatch(id) ?? null };
  }
  const updated = await mutateFurnaceBatch(id, (b) => { b.stopRequested = true; if (!b.stopReason) b.stopReason = reason; });
  void stokerTick(id); // kick a drain tick so it starts finalizing promptly
  log.info(`[furnace] batch ${id} stop requested (graceful drain): ${reason}`);
  return { ok: true, batch: updated };
}

// ── Manual recovery actions (FLUX-1066 §4 — the escape hatch) ─────────────────────

/**
 * FLUX-1066 (M2) pure guard for {@link retryTicket}. A retry re-queues a ticket for a FULL fresh burn,
 * wiping `prUrl`/`lastReviewState` — harmless for a parked/failed ticket, but DESTRUCTIVE for a `pr-open`
 * one: it already succeeded, so re-burning duplicates the work and drops the open PR link. The drawer gates
 * Retry to parked/failed, but `furnace_ticket action:"retry"` (MCP + REST) takes a bare ticketId, so the guard lives here.
 * Returns the rejection reason, or null when the retry is allowed. `force` (the explicit hand-back path)
 * bypasses the pr-open guard AND the active-state guard (FLUX-1090) — `handBackTicket` stops any live
 * session for the ticket itself before calling in, so a ticket whose bookkeeping state is stuck
 * `implementing`/`reviewing` (a zombie auto-takeover, or a human who kept a session open) can always be
 * reclaimed instead of hitting a dead "still burning" rejection with no session left to stop.
 */
export function retryRejectionReason(ticket: BatchTicket, force: boolean): string | null {
  if (isActiveTicketState(ticket.state) && !force) return 'ticket is still burning — stop it first';
  if (ticket.state === 'pr-open' && !force) {
    return 'ticket already has an open PR (approved) — dismiss its flag or take it over instead; hand back re-burns it explicitly';
  }
  return null;
}

/**
 * Retry a single parked/failed ticket — reset it to `queued` with a FRESH attempt budget
 * (attempts/exhaustion/spawn-failure counters + cooldown all cleared) and hand ownership back to the
 * Furnace. It re-burns on the next tick IF the batch is burning; a terminal batch must be resumed
 * (`resumeBatch`) to pick it up. Clears the board flag best-effort. A `pr-open` ticket is REJECTED unless
 * `opts.force` (the hand-back path) — re-burning an approved, PR-open ticket would drop its PR and duplicate
 * the work (M2).
 */
export async function retryTicket(batchId: string, ticketId: string, opts: { force?: boolean } = {}): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(batchId);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  const t = findTicket(batch, ticketId);
  if (!t) return { ok: false, error: 'Ticket not in batch' };
  const reject = retryRejectionReason(t, !!opts.force);
  if (reject) return { ok: false, error: reject };

  await clearFurnaceFlag(ticketId, `Furnace retrying ${ticketId} — flag cleared, fresh attempt budget.`);
  const updated = await mutateFurnaceBatch(batchId, (b) => {
    const x = findTicket(b, ticketId);
    if (!x) return;
    x.state = 'queued';
    x.attempts = 0;
    x.owner = 'furnace';
    delete x.exhaustionAttempts;
    delete x.spawnFailures;
    delete x.failureClass;
    delete x.flagDismissed;
    delete x.note;
    delete x.endedAt;
    delete x.currentSessionId;
    delete x.currentPhase;
    delete x.prUrl;
    clearCooldownState(x);
  });
  if (batch.status === 'burning') void stokerTick(batchId);
  log.info(`[furnace] ${ticketId} retried — reset to queued (fresh attempt budget).`);
  return { ok: true, batch: updated };
}

/**
 * Resume a halted (`parked`) or finished (`done`) batch → `burning`. Resets the circuit breaker + clears
 * the stop request/reason so the breaker doesn't immediately re-trip, re-queues tickets that were merely
 * `skipped` by the halt (so the batch actually continues), and drops the stale terminal report. Claims a
 * worktree slot like a fresh ignite — fails `no_slots` when the pool is full. Parked/failed tickets are
 * NOT auto-re-queued (retry those individually); `pr-open` successes are preserved.
 */
export async function resumeBatch(id: string): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(id);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  if (batch.status === 'burning') return { ok: true, batch }; // idempotent
  if (batch.status === 'draft') return { ok: false, error: 'batch is a draft — ignite it instead' };

  await mutateFurnaceBatch(id, (b) => {
    b.consecutiveFailures = 0;
    delete b.stopRequested;
    delete b.stopReason;
    delete b.report;
    delete b.completedAt;
    for (const t of b.tickets) {
      if (t.state === 'skipped') { t.state = 'queued'; t.owner = 'furnace'; delete t.note; delete t.endedAt; delete t.failureClass; }
    }
  });

  // FLUX-1157: same reclaim-before-recount as igniteBatch — a resumed batch claims a slot exactly like a
  // fresh ignite, so it must not be refused by a stale, actually-reclaimable worktree either.
  const root = requireWorkspaceRoot();
  await reclaimReadyWorktrees(root).catch(() => [] as string[]);
  await refreshWorktreePool({ force: true });
  const claim = await claimSlotsAndIgnite(id, nowIso(), FURNACE_SLOT_CAP);
  if (!claim.ok) return claimFailureResult(claim, root);
  void stokerTick(id);
  log.info(`[furnace] batch ${id} resumed — breaker reset, ${claim.batch?.status}.`);
  return { ok: true, batch: claim.batch ?? null };
}

/**
 * Dismiss the Furnace-raised flag on a ticket ("I've got this") — clear the board `require-input`
 * swimlane and mark it dismissed WITHOUT re-queuing. Works on a `done`/terminal batch too (the FLUX-1063
 * case: a parked ticket in a finished batch whose flag no tool could clear).
 */
export async function dismissTicketFlag(batchId: string, ticketId: string): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(batchId);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  const t = findTicket(batch, ticketId);
  if (!t) return { ok: false, error: 'Ticket not in batch' };
  await clearFurnaceFlag(ticketId, `Furnace flag on ${ticketId} dismissed — a human has it.`);
  const updated = await mutateFurnaceBatch(batchId, (b) => {
    const x = findTicket(b, ticketId);
    if (x) x.flagDismissed = true;
  });
  log.info(`[furnace] ${ticketId} flag dismissed (no re-queue).`);
  return { ok: true, batch: updated };
}

/**
 * Explicit takeover — mark a ticket `owner: human`, stop the Furnace session driving it (so the human
 * drives cleanly), and settle it. The Furnace never reclaims its worktree (a `human`-owned ticket sits at
 * a non-terminal board status, so the worktree-reclaim sweep leaves it alone). Idempotent.
 */
export async function takeoverTicket(batchId: string, ticketId: string): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(batchId);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  const t = findTicket(batch, ticketId);
  if (!t) return { ok: false, error: 'Ticket not in batch' };
  try { stopAllSessionsForTask(ticketId, 'human takeover — Furnace yielding'); } catch { /* best effort */ }
  const updated = await mutateFurnaceBatch(batchId, (b) => {
    const x = findTicket(b, ticketId);
    if (!x) return;
    settleAsHumanOwned(x);
  });
  // B1: clear the Furnace-raised `require-input` flag on takeover — the "Take over" button is shown on
  // parked/failed rows where `parkTicketOnBoard` raised it, so without this the taken-over ticket keeps an
  // undismissable flag whose only escape was handing it back to the Furnace (the exact dead-end this fixes).
  await clearFurnaceFlag(ticketId, `Furnace flag on ${ticketId} cleared — you have taken this over.`);
  log.info(`[furnace] ${ticketId} taken over by a human — Furnace yielded.`);
  return { ok: true, batch: updated };
}

/**
 * Hand a taken-over ticket back to the Furnace — the inverse of {@link takeoverTicket}. Re-queues it with
 * a fresh attempt budget under Furnace ownership; re-burns on the next tick if the batch is burning (else
 * resume the batch). Reuses the retry reset.
 */
export async function handBackTicket(batchId: string, ticketId: string): Promise<BatchControlResult> {
  await ensureFurnaceLoaded();
  const batch = getFurnaceBatch(batchId);
  if (!batch) return { ok: false, error: 'Furnace batch not found' };
  const t = findTicket(batch, ticketId);
  if (!t) return { ok: false, error: 'Ticket not in batch' };
  if (!isHumanOwned(t)) return { ok: false, error: 'ticket is not owned by a human' };
  // FLUX-1090: stop any still-live session for the ticket FIRST (mirrors takeoverTicket's own use of this
  // in the opposite direction) — this is what makes a hand-back robust on a ticket stuck in an active
  // state (a zombie auto-takeover from before the race fix, or a human who left a session running):
  // there's no live session left to reject on afterward.
  try { stopAllSessionsForTask(ticketId, 'furnace hand-back — reclaiming from the human'); } catch { /* best effort */ }
  // force: an explicit hand-back may re-burn even a `pr-open` ticket (the human is deliberately returning it
  // to the Furnace), bypassing retryTicket's pr-open guard (M2) AND its active-state guard (FLUX-1090).
  return retryTicket(batchId, ticketId, { force: true });
}

// Re-exports for callers migrating off the old run helpers.
export { effectiveConcurrency, clampBurnRate, terminalTicketCount };
