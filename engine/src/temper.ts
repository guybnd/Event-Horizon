// Temper (FLUX-1071) — "the Furnace for a single ticket."
//
// A board mode. When Temper is enabled and a ticket that has a branch reaches Ready, the engine
// automatically runs a review session and then loops review → re-implementation → re-review with no
// human clicks until one of two things happens:
//   approved          → the loop STOPS and the ticket stays at Ready as an approved/green PR. It is
//                        NEVER auto-merged (matches the Furnace's never-merge invariant).
//   changes-requested → the ticket re-implements (a fresh implementation session with the
//                        "address review feedback" focus) and is re-reviewed, up to `TEMPER_RETRY_CAP`
//                        re-implementation attempts, after which it PARKS (Require Input swimlane) so a
//                        human is pulled in rather than looping forever.
//
// This is deliberately NOT a Furnace batch — it drives ONE ticket at a time, board-wide, off the same
// tick cadence as the Stoker. Rather than reimplement the implement→review→reimplement decision, it
// REUSES the Stoker's pure decision core (`decideTicketAction`) verbatim and its dispatch/park plumbing;
// the only thing this module owns is the per-ticket bookkeeping (an in-memory synthetic `BatchTicket`)
// and the trigger/loop lifecycle. Because the loop is engine-side, it keeps progressing with no portal
// open (AC #6).
//
// Scope choices (see the ticket's Open Questions — using the groomed defaults):
//   • Only tickets WITH a branch auto-loop ("green PR" is only meaningful with a PR).
//   • A ticket already driven by an active Furnace batch is skipped (the batch wins — AC #7).
//   • Transient failure sub-machines the Furnace has (rate-limit cooldown, context-exhaustion retry) are
//     intentionally NOT reimplemented here — a Temper ticket whose session dies from a rate/context limit
//     simply parks for the (present) human. Temper omits `terminalReason`, so `decideTicketAction` routes
//     those to a plain park instead of a cooldown/retry action this module can't service.
//
// FLUX-1261: the board-wide on/off switch used to be the standalone `temperEnabled` boolean; it is
// now `gatePolicy.boardDefault.review === 'auto'` (+ a per-ticket override), generalized alongside
// the new `plan` gate. Only the trigger condition changed here — the loop-forever mechanics below
// are untouched pending the generalized loop-driver ("Plan-review runner" subtask).

import { getWorkspace } from './workspace-context.js';
import { log } from './log.js';
import { getConfig } from './config.js';
import { updateTaskWithHistory } from './task-store.js';
import { cliSessionsById, getActiveSessionsForTask } from './session-store.js';
import { getBurningBatches, freeSlots, ticketHasObservedWorktree, setTemperReserved, isTemperReserved } from './furnace-store.js';
import {
  isActiveTicketState,
  isTerminalTicketState,
  DEFAULT_RETRY_CAP,
  type BatchTicket,
  type FurnacePhase,
} from './models/furnace.js';
import { resolveGateValue } from './models/gate-policy.js';
import {
  decideTicketAction,
  dispatchSession,
  resumeOrDispatchSession,
  parkTicketOnBoard,
  clearReviewState,
  extractPrUrl,
  findSessionOutcome,
  lastCommentMatchesVerdictMarker,
  pickSessionForPhase,
  refreshWorktreePool,
  SOLE_REVIEWER_FOCUS,
  deltaReviewFocus,
  REIMPLEMENT_FOCUS,
  REVIEW_NUDGE_FOCUS,
  REVIEW_RETRY_FOCUS,
  type TicketAction,
} from './furnace-stoker.js';

const TEMPER_INTERVAL_MS = 5_000;

/** Re-implementation attempts before Temper parks a ticket (mirrors the Furnace default per the plan). */
const TEMPER_RETRY_CAP = DEFAULT_RETRY_CAP;

/** Consecutive spawn failures before Temper parks a ticket (a broken environment can't wedge the loop). */
const MAX_TEMPER_SPAWN_ATTEMPTS = 6;

const nowIso = () => new Date().toISOString();

/**
 * In-memory per-ticket loop state, one synthetic `BatchTicket` per actively-tempering ticket. Reusing
 * the `BatchTicket` shape lets `decideTicketAction` consume it unchanged. The durable companion is the
 * ticket's own frontmatter (`tempering`/`temperAttempts`, written via `updateTaskWithHistory`), which is
 * what the portal reads and what {@link rehydrateTemper} restores this map from after an engine restart.
 */
const temperTickets = new Map<string, BatchTicket>();

/** Is this ticket currently being driven by Temper (in-memory)? */
export function isTempering(ticketId: string): boolean {
  return temperTickets.has(ticketId);
}

/** FLUX-1071: a ticket owned by an active Furnace batch must not be double-driven by Temper (AC #7).
 *  FLUX-1263: exported — the generalized plan-review gate runner (`gate-runner.ts`) preserves this same
 *  yield-to-an-active-batch precedence rather than re-deriving it. */
export function isTicketInActiveFurnaceBatch(ticketId: string): boolean {
  for (const b of getBurningBatches()) {
    const t = b.tickets.find((x) => x.ticketId === ticketId);
    if (t && !isTerminalTicketState(t.state)) return true;
  }
  return false;
}

const readyStatus = (): string => getConfig().readyForMergeStatus || 'Ready';

// ── Trigger ──────────────────────────────────────────────────────────────────

/**
 * Called from the `change_status` handler after a ticket has been committed to a new status. Starts the
 * Temper loop when a ticket ENTERS Ready with the mode on — but only for a genuine first entry, never for
 * Temper's own re-implementation returning to Ready (the re-implementation session moves the ticket back
 * to Ready itself). Re-entrancy is closed three ways: the status guard (only a non-Ready → Ready move),
 * the durable `tempering` frontmatter flag, and the in-memory registry — the last two are already set for
 * a ticket mid-loop, so its re-implementation's Ready move is a no-op here.
 */
export async function maybeStartTemper(
  ticketId: string,
  newStatus: string,
  prevStatus: string,
  verdictJustRecorded?: 'approved' | 'changes-requested' | null,
): Promise<void> {
  // Only a genuine ENTER-Ready transition — not a re-affirming Ready→Ready (a review approving in place).
  if (newStatus !== readyStatus() || prevStatus === readyStatus()) return;
  // FLUX-1394: a change_status that CARRIES a review verdict is a review CONCLUDING, never a ticket
  // ENTERING review — do not (re-)arm Temper. Arming would clearReviewState (the `review` action below),
  // wiping the verdict just recorded, and dispatch a redundant re-review — wasted cost, and a false
  // "review completed without a verdict" park when that re-review ends without re-recording one. The
  // prevStatus/tempering guards below miss an In Progress→Ready approval on a non-tempering ticket (e.g.
  // a human approving a parked ticket, or a re-dispatched review approving after a park cleared
  // `tempering`). Mirrors the plan gate, whose `evaluatePlanGateTrigger` already bakes this verdict check
  // into its trigger predicate. NB: this is the verdict recorded by THIS change_status call — NOT the
  // persisted `task.reviewState`, which could be a stale 'approved' from a prior cycle that must not
  // block a genuinely fresh review of re-opened work.
  if (verdictJustRecorded) return;
  const task = getWorkspace().tasks[ticketId];
  if (!task) return;
  // FLUX-1261: temperEnabled generalized into gatePolicy.boardDefault.review (+ ticket override
  // cascade). Only 'auto' is wired to Temper's existing loop-forever behavior here — 'auto-then-you'
  // is schema-only until the generalized runner ("Plan-review runner" subtask) lands its
  // one-pass-then-flag semantics.
  if (resolveGateValue(getConfig().gatePolicy, task.gatePolicyOverride, 'review') !== 'auto') return;
  // "Green PR" is only meaningful with a branch; branchless tickets are left alone (groomed default).
  if (!task.branch) return;
  // Already looping (durable flag or in-memory) → the reconciler owns it; don't reset attempts.
  if (task.tempering === true || temperTickets.has(ticketId)) return;
  // A Furnace batch already drives this ticket — the batch wins (AC #7).
  if (isTicketInActiveFurnaceBatch(ticketId)) return;

  // Seed the registry SYNCHRONOUSLY (before any await) so a rapid second trigger can't double-start.
  temperTickets.set(ticketId, { ticketId, order: 0, state: 'reviewing', attempts: 0, sessionIds: [] });
  try {
    await updateTaskWithHistory(ticketId, {
      extraFields: { tempering: true, temperAttempts: 0 },
      entries: [{
        type: 'activity',
        user: 'Temper',
        comment: 'Temper on — auto-reviewing this ticket. It will loop review → re-implementation until the reviewer approves (PR left open at Ready, never merged), or park after ' + TEMPER_RETRY_CAP + ' re-implementation attempts.',
        date: nowIso(),
      }],
      updatedBy: 'Temper',
    });
  } catch (e: unknown) {
    log.warn(`[temper] ${ticketId} start persist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Dispatch the first review now (the tick would also pick it up, but this makes it immediate).
  await advanceTemperTicket(ticketId, { type: 'review' });
  // FLUX-1239: spawnTemper may have returned early (pool full) without dispatching anything — check
  // whether a session actually landed before claiming so, rather than logging "dispatched" unconditionally.
  const dispatched = !!temperTickets.get(ticketId)?.currentSessionId;
  log.info(dispatched
    ? `[temper] ${ticketId} entered ${readyStatus()} with Temper on — first review dispatched.`
    : `[temper] ${ticketId} entered ${readyStatus()} with Temper on — waiting for a free worktree slot before the first review.`);
}

// ── Lifecycle helpers ──────────────────────────────────────────────────────────

/** Persist the current re-implementation attempt count onto the ticket (best-effort). */
async function persistTemperAttempts(ticketId: string, attempts: number): Promise<void> {
  try {
    await updateTaskWithHistory(ticketId, { extraFields: { temperAttempts: attempts }, updatedBy: 'Temper' });
  } catch (e: unknown) {
    log.warn(`[temper] ${ticketId} persist attempts failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Stop tempering a ticket: drop it from the registry and clear its durable Temper frontmatter fields. */
async function stopTemper(ticketId: string, note?: string): Promise<void> {
  temperTickets.delete(ticketId);
  setTemperReserved(ticketId, false);
  try {
    await updateTaskWithHistory(ticketId, {
      deleteFields: ['tempering', 'temperAttempts'],
      ...(note ? { entries: [{ type: 'activity', user: 'Temper', comment: note, date: nowIso() }] } : {}),
      updatedBy: 'Temper',
    });
  } catch (e: unknown) {
    log.warn(`[temper] ${ticketId} stop persist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * FLUX-1297: called by a finish/merge flow that is about to stop this ticket's sessions itself — a
 * deliberate, expected teardown, not a failure. Disarms Temper FIRST so its own tick can never observe
 * the resulting 'cancelled' session and park a ticket whose work already landed (the race the
 * `decideTicketAction` 'yield' branch only catches defensively). No-op if Temper isn't driving this ticket.
 */
export async function disarmTemperForExternalStop(ticketId: string): Promise<void> {
  if (!temperTickets.has(ticketId)) return;
  await stopTemper(ticketId, 'Temper disarmed — a finish/merge flow is taking over session teardown for this ticket.');
  log.info(`[temper] ${ticketId} disarmed ahead of an external session stop (finish/merge flow).`);
}

/** Park a Temper ticket for a human (Require Input swimlane) and clear its Temper state. */
async function parkTemper(ticketId: string, reason: string): Promise<void> {
  await parkTicketOnBoard(ticketId, `Temper: ${reason}`);
  // parkTicketOnBoard set the swimlane + moved the ticket to In Progress; this only drops the two
  // Temper fields (deleteFields is scoped, so the swimlane/status it just wrote are preserved).
  await stopTemper(ticketId);
  log.info(`[temper] ${ticketId} parked: ${reason}`);
}

/**
 * Dispatch a phase session for a Temper ticket, recording the new session on success or counting a spawn
 * failure (parking the ticket once past the cap, so a broken environment can't wedge the loop). The ticket
 * is left in its target state either way — on failure the next tick observes no session and re-drives it.
 *
 * FLUX-1237: a full shared worktree pool is NOT a spawn failure — it returns early (a `wait`) without
 * touching `spawnFailures`, so contention with the Furnace for slots can never park a ticket.
 */
async function spawnTemper(ticket: BatchTicket, phase: FurnacePhase, focusComment?: string, useResume = false): Promise<void> {
  // FLUX-1237: Temper and the Furnace draw from the SAME global worktree pool, so gate the isolated
  // dispatch on slot availability exactly as the Stoker does (`freeSlots`, see furnace-stoker.ts). Without
  // this, a burst of branch tickets entering Ready could each try to grab a slot and, after
  // MAX_TEMPER_SPAWN_ATTEMPTS refusals from a momentarily-full pool, PARK a ticket that only needed to WAIT
  // for a slot to free. When no slot is free we leave the ticket in its current state and return: the next
  // tick observes no session and re-drives the phase (`decideTicketAction` → `redrive`), which does NOT
  // re-bump attempts or spawnFailures. Refresh the observed pool first (cheap — TTL-coalesced) so the check
  // sees the freshest count, including worktrees the Furnace is holding right now.
  // FLUX-1244: only gate a spawn that would claim a NEW slot. A ticket that ALREADY holds a worktree
  // (a re-implement/re-review mid-loop reuses it via the shared branch — no new slot) must NOT be blocked:
  // its own worktree counts toward `freeSlots()`, so gating it unconditionally lets a full pool self-stall
  // an in-flight loop until unrelated work frees a slot. A brand-new loop (no worktree yet) still waits.
  await refreshWorktreePool();
  const holdsSlot = ticketHasObservedWorktree(ticket.ticketId) || isTemperReserved(ticket.ticketId);
  if (!holdsSlot) {
    // FLUX-1239: `refreshWorktreePool()` is TTL-coalesced, so several sibling tickets entering Ready in the
    // same tick/TTL window would otherwise all read the same stale on-disk count and all pass this gate,
    // over-committing the pool. Check-then-reserve synchronously — no `await` between the two — so the
    // very next sibling call in this burst sees `freeSlots()` already decremented by this reservation.
    if (freeSlots() < 1) {
      log.info(`[temper] ${ticket.ticketId} waiting for a free worktree slot before its ${phase} session (shared Furnace pool full).`);
      return;
    }
    setTemperReserved(ticket.ticketId, true);
  }
  // dispatchSession/resumeOrDispatchSession both return a classified DispatchOutcome (FLUX-1235); Temper
  // only needs the session id (null = refused). A refusal here is a genuine spawn failure — the pool-full
  // case already returned above. FLUX-1378: `useResume` (currently only the 're-implement' dispatch, mirroring
  // gate-runner/furnace-stoker) tries resuming the implementer's prior session before falling back to cold.
  const { sid } = useResume && focusComment
    ? await resumeOrDispatchSession(ticket.ticketId, phase, { focusComment, resumeMessage: focusComment })
    : await dispatchSession(ticket.ticketId, phase, focusComment ? { focusComment } : {});
  if (sid) {
    ticket.currentSessionId = sid;
    if (!ticket.sessionIds.includes(sid)) ticket.sessionIds.push(sid);
    ticket.sessionStartedAt = nowIso();
    ticket.spawnFailures = 0;
    return;
  }
  // No worktree was actually claimed — release the reservation so it doesn't eat a slot indefinitely.
  setTemperReserved(ticket.ticketId, false);
  ticket.spawnFailures = (ticket.spawnFailures || 0) + 1;
  if (ticket.spawnFailures >= MAX_TEMPER_SPAWN_ATTEMPTS) {
    await parkTemper(ticket.ticketId, `could not start a ${phase} session after ${MAX_TEMPER_SPAWN_ATTEMPTS} attempts (the environment may be broken)`);
  }
}

// ── Executor ────────────────────────────────────────────────────────────────────

/**
 * Execute the decision for a single Temper ticket. Handles only the actions Temper can produce (Temper
 * omits the rate-limit/context-exhaustion inputs, so `decideTicketAction` never returns their actions).
 */
async function advanceTemperTicket(ticketId: string, action: TicketAction): Promise<void> {
  const ticket = temperTickets.get(ticketId);
  if (!ticket) return;
  switch (action.type) {
    case 'wait':
      return;

    case 'review': {
      ticket.state = 'reviewing';
      ticket.currentPhase = 'review';
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      ticket.reviewNudgeSent = false; // a fresh review pass gets a fresh nudge budget (FLUX-1078)
      await clearReviewState(ticketId); // clear a stale verdict before the fresh review reads its own
      await spawnTemper(ticket, 'review', SOLE_REVIEWER_FOCUS + deltaReviewFocus(ticketId));
      break;
    }

    case 'review-nudge': {
      // FLUX-1078: the review completed with reviewState unset but a verdict-shaped comment — give it one
      // corrective pass to record the verdict via change_status before parking.
      ticket.reviewNudgeSent = true;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await spawnTemper(ticket, 'review', REVIEW_NUDGE_FOCUS);
      log.info(`[temper] ${ticketId} review left a verdict-shaped comment without change_status — nudging instead of parking.`);
      break;
    }

    case 'review-retry': {
      // FLUX-1437: no verdict AND no verdict-shaped comment (the FLUX-1434 incident shape) — one
      // fresh review pass before parking. Shares reviewNudgeSent with review-nudge above.
      ticket.reviewNudgeSent = true;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await spawnTemper(ticket, 'review', REVIEW_RETRY_FOCUS);
      log.info(`[temper] ${ticketId} review completed without a verdict or a verdict-shaped comment — giving it one fresh review pass before parking.`);
      break;
    }

    case 'reimplement': {
      ticket.state = 'reimplementing';
      ticket.currentPhase = 'implementation';
      ticket.attempts = action.attempt;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await persistTemperAttempts(ticketId, action.attempt);
      await spawnTemper(ticket, 'implementation', REIMPLEMENT_FOCUS, true);
      break;
    }

    case 'redrive': {
      // No observable session (spawn failed last tick, or the engine restarted) — re-drive the phase.
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      const focus = action.phase === 'review'
        ? SOLE_REVIEWER_FOCUS + deltaReviewFocus(ticketId)
        : ticket.state === 'reimplementing' ? REIMPLEMENT_FOCUS : undefined;
      await spawnTemper(ticket, action.phase, focus);
      break;
    }

    case 'pr-open': {
      await stopTemper(ticketId, `Temper complete — the review approved this ticket. PR left open at ${readyStatus()} (not merged).`);
      log.info(`[temper] ${ticketId} approved — PR left open at ${readyStatus()} (not merged). Temper complete.`);
      break;
    }

    case 'park': {
      await parkTemper(ticketId, action.reason);
      break;
    }

    case 'yield': {
      // FLUX-1297: the ticket already succeeded outside Temper's control (its board status is already
      // merged/terminal) — a finish/merge flow deliberately killed the review session. Disarm quietly
      // instead of parking a ticket that already landed.
      await stopTemper(ticketId, `Temper yielded — ${action.reason}.`);
      log.info(`[temper] ${ticketId} yielded — ${action.reason}.`);
      break;
    }

    // Temper never produces these (it omits the rate-limit/exhaustion inputs) — ignore defensively.
    case 'retry-exhausted':
    case 'cooldown-rate-limited':
    case 'retry-rate-limited':
      return;
  }
}

// ── Reconcile ──────────────────────────────────────────────────────────────────

/** Observe one Temper ticket's session and advance it. Mirrors the Stoker's `reconcileTicket`. */
async function reconcileTemperTicket(ticketId: string): Promise<void> {
  const ticket = temperTickets.get(ticketId);
  if (!ticket) return;

  // A Furnace batch adopted this ticket mid-loop → yield entirely (the batch wins — AC #7).
  if (isTicketInActiveFurnaceBatch(ticketId)) {
    await stopTemper(ticketId, 'Temper yielded — this ticket is now driven by an active Furnace batch.');
    log.info(`[temper] ${ticketId} now owned by an active Furnace batch — Temper yielding.`);
    return;
  }
  if (!isActiveTicketState(ticket.state)) return;

  const currentPhase: FurnacePhase = ticket.state === 'reviewing' ? 'review' : 'implementation';
  // Prefer the tracked session (it stays resolvable after it terminates); else adopt the live phase session.
  let sess = ticket.currentSessionId ? cliSessionsById.get(ticket.currentSessionId) : undefined;
  if (!sess) sess = pickSessionForPhase(getActiveSessionsForTask(ticketId), currentPhase);
  if (sess && sess.id !== ticket.currentSessionId) {
    ticket.currentSessionId = sess.id;
    if (!ticket.sessionIds.includes(sess.id)) ticket.sessionIds.push(sess.id);
    if (!ticket.sessionStartedAt) ticket.sessionStartedAt = nowIso();
  }

  const task = getWorkspace().tasks[ticketId];
  const prUrl = extractPrUrl(task);
  const sessionOutcome = findSessionOutcome(task, sess?.id ?? ticket.currentSessionId);
  const action = decideTicketAction({
    ticket,
    ...(sess ? { sessionStatus: sess.status } : {}),
    // NB: deliberately NOT passing terminalReason — Temper parks on rate/context limits (see file header).
    ...(sessionOutcome ? { sessionOutcome } : {}),
    reviewState: task?.reviewState ?? null,
    ...(task?.status ? { ticketStatus: task.status } : {}),
    ...(getConfig().requireInputStatus ? { requireInputStatus: getConfig().requireInputStatus } : {}),
    retryCap: TEMPER_RETRY_CAP,
    ...(prUrl !== undefined ? { prUrl } : {}),
    // FLUX-1080: scope the verdict-marker scan to the CURRENT review pass so a stale prior-round comment
    // can't be mistaken for this round's verdict.
    reviewVerdictMarkerSeen: lastCommentMatchesVerdictMarker(task?.history, ticket.sessionStartedAt),
  });
  await advanceTemperTicket(ticketId, action);
}

// ── Tick orchestration ──────────────────────────────────────────────────────────

let ticking = false;

/** Advance every actively-tempering ticket by one tick. Never overlaps itself. */
export async function temperTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const ticketId of [...temperTickets.keys()]) {
      try {
        await reconcileTemperTicket(ticketId);
      } catch (e: unknown) {
        log.error(`[temper] tick for ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    ticking = false;
  }
}

/**
 * Restore the in-memory registry from durable frontmatter after an engine restart, so the loop survives
 * a bounce. Each restored ticket starts in `reviewing` with no session; the first tick observes no live
 * session and re-drives the review (`decideTicketAction` → `redrive`), which is the correct resumption
 * point regardless of which phase was mid-flight when the engine went down.
 */
export function rehydrateTemper(): void {
  for (const id of Object.keys(getWorkspace().tasks)) {
    const t = getWorkspace().tasks[id];
    if (t?.tempering === true && !temperTickets.has(id)) {
      const attempts = typeof t.temperAttempts === 'number' ? t.temperAttempts : 0;
      temperTickets.set(id, { ticketId: id, order: 0, state: 'reviewing', attempts, sessionIds: [] });
      log.info(`[temper] rehydrated ${id} (attempts ${attempts}) — will re-drive its review on the next tick.`);
    }
  }
}

let temperTimer: ReturnType<typeof setInterval> | null = null;

/** Start the background Temper loop (idempotent). Rehydrates first so a restart resumes in-flight loops. */
export function startTemper(): void {
  if (temperTimer) return;
  rehydrateTemper();
  temperTimer = setInterval(() => { void temperTick(); }, TEMPER_INTERVAL_MS);
  temperTimer.unref?.();
  log.info('[temper] loop started.');
}

export function stopTemperLoop(): void {
  if (temperTimer) { clearInterval(temperTimer); temperTimer = null; }
}

/** Test-only: clear the in-memory loop registry between cases (the map is process-lived in production). */
export function __resetTemperForTests(): void {
  temperTickets.clear();
  ticking = false;
}
