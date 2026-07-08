// Plan-review gate runner (FLUX-1263) — the generalized, gate-parametrized loop-driver that turns a
// gate-policy value into real runtime behavior. Modeled directly on Temper's (FLUX-1071, `temper.ts`)
// single-ticket driver — a synthetic `BatchTicket` per running ticket, reusing the Stoker's pure decision
// core (`decideTicketAction`) and its dispatch plumbing verbatim — but parametrized by a `GateRunSpec` so
// a second gate (the `review` gate's own Auto behavior, a separate sibling ticket per FLUX-1247) can plug
// into this SAME module later without modifying it: only the terminal-approved action, the verdict field,
// the revise-phase, and the focus text differ per gate; the state machine + retry/park mechanics do not.
//
// Only the `plan` gate is wired here. `plan` differs from Temper's `review` loop in one structural way:
// Temper's loop starts AFTER the ticket already entered Ready (a branch/PR exists); the plan gate's loop
// runs INSTEAD OF a direct Grooming -> Todo move (see `evaluatePlanGateTrigger` in mcp-server.ts) — the
// ticket never leaves Grooming until the gate itself calls `onApproved`. Plan review also never needs a
// worktree/branch (there is no diff to review, only a ticket's plan text + artifact), so — unlike Temper —
// this module never touches the shared Furnace worktree-slot pool; every dispatched session passes
// `skipIsolation` and runs branchless in the shared checkout, exactly like a normal grooming session does.
//
// Trigger + mode semantics (decided by the caller, not this module) — see `PlanGateMode` below:
//   `you`          -> never auto-starts (mcp-server's guard never calls `startPlanGateNow` for this value);
//                     a human (or an agent on their behalf) can still explicitly invoke ONE pass via the
//                     `start_plan_review` MCP tool — always `mode: 'one-pass'`, same as manual runs under
//                     any gate value: it never loops regardless of gate value.
//   `auto-then-you`-> `startPlanGateNow(ticketId, { mode: 'loop-confirm' })` (FLUX-1288): loops review ->
//                     revise -> re-review up to the shared `DEFAULT_RETRY_CAP`, same as `auto` below — but
//                     an approved verdict STOPS the loop instead of auto-moving: the ticket stays in
//                     Grooming with `planReviewState: 'approved'` for a human to confirm via a later
//                     `change_status` call (which the same guard lets straight through once a verdict
//                     already exists). The human is always the one who moves it to Todo; only the
//                     iteration (review -> revise -> re-review) is automated.
//   `auto`         -> `startPlanGateNow(ticketId, { mode: 'loop-auto' })`: loops review -> revise -> re-review
//                     up to the shared `DEFAULT_RETRY_CAP`; approved moves Grooming -> Todo automatically
//                     (`onApproved`, bypassing `change_status` entirely — same pattern as Temper's `pr-open`
//                     not re-invoking the tool it was triggered from); retryCap exhaustion parks (raises a
//                     ⛔ gate-parked item via the existing `parkTicketOnBoard` Furnace-park marker).

import { log } from './log.js';
import { configCache, nextColumnAfter } from './config.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { generateNeedsActionNotification } from './notifications.js';
import { cliSessionsById, getActiveSessionsForTask } from './session-store.js';
import { isActiveTicketState, DEFAULT_RETRY_CAP, type BatchTicket, type FurnacePhase } from './models/furnace.js';
import { planBodyHash, planGateModeForRevise, resolveGateValue, resolvePlanReviewDepth, type PlanReviewDepth } from './models/gate-policy.js';
import { isTicketInActiveFurnaceBatch } from './temper.js';
import {
  decideTicketAction,
  dispatchSession,
  parkTicketOnBoard,
  findSessionOutcome,
  lastCommentMatchesVerdictMarker,
  pickSessionForPhase,
  type TicketAction,
} from './furnace-stoker.js';

const GATE_RUNNER_INTERVAL_MS = 5_000;

/** Consecutive spawn failures before a gate run parks a ticket (a broken environment can't wedge the loop). */
const MAX_GATE_SPAWN_ATTEMPTS = 6;

const nowIso = () => new Date().toISOString();

// ── Focus text (depth-scaled plan-review instructions) ──────────────────────────────────────────────

const PLAN_REVIEW_BASE =
  'You are reviewing a TICKET PLAN, not committed code — this ticket is still in Grooming and has no diff. ' +
  "Read its full description (title, body, `## Acceptance criteria`) and its latest published artifact (if any) as the plan under review.";

const ANCHOR_CHECK =
  "Anchor check: for every file/symbol/line the plan cites, verify with Serena/grep that it still exists and still means what the plan says. " +
  "Re-derive this fresh from the CURRENT code every pass — never trust a prior pass's citations, even your own.";

const REGROUND_CHECK =
  'Reground (FLUX-1048): check `.docs/release-notes/INDEX.md` plus recently Done/Released and sibling tickets (same parent) for work that already landed part or all of this plan.';

const AC_COVERAGE_CHECK =
  'Acceptance-criteria coverage: confirm the `## Acceptance criteria` checklist (if present) is concrete/testable and that the Implementation Plan actually addresses every item — flag any item the plan leaves uncovered.';

const DUPLICATE_CHECK =
  'Duplicate check: search open/groomed tickets for one that already covers this same change (a duplicate or near-duplicate scope) and flag it if found.';

const ADVERSARIAL_CHECK =
  "Adversarial self-review (Plan Discipline item 4): read the plan as its harshest critic — find what's weak, missing, or wrong: an unanchored step, an implicit hard-to-reverse decision left unstated, a menu of options where the plan should commit to one, an obvious missing decision. A clear-cut fixable gap is Minor; a genuine judgment call the plan ducked is Major/Blocker.";

const PLAN_VERDICT_CONTRACT =
  'Record your verdict via `change_status` — leave `newStatus` as "Grooming" (do NOT move the ticket) and set `planReviewState` to "approved" or "changes-requested" (never `reviewState`; that is a different field for the post-Todo code-review gate). ' +
  'Posting a comment that starts with **APPROVED** or **CHANGES NEEDED** is not enough by itself — without the `change_status` call the ticket will be parked for a human over an unrecorded verdict.';

/** The focus handed to a plan-review session, scaled to the resolved depth (Quick/Standard/Thorough). */
export function planReviewFocus(depth: PlanReviewDepth): string {
  const checks = [ANCHOR_CHECK];
  if (depth === 'standard' || depth === 'thorough') checks.push(REGROUND_CHECK, AC_COVERAGE_CHECK);
  if (depth === 'thorough') checks.push(DUPLICATE_CHECK, ADVERSARIAL_CHECK);
  return `${PLAN_REVIEW_BASE} Depth: ${depth}. ${checks.join(' ')} ${PLAN_VERDICT_CONTRACT}`;
}

/** The focus for a "revise the plan" pass after a plan-review pass requested changes. */
export const PLAN_REVISE_FOCUS =
  "A plan-review pass just requested changes on this ticket's plan (see the latest review comment in its history) — revise the ticket body via `update_ticket` to address every point raised, then STOP. " +
  'Do not call `change_status` yourself and do not start implementing; the plan-review gate automatically re-reviews your revision.';

/** Mirrors Temper's `REVIEW_NUDGE_FOCUS`, keyed to `planReviewState` instead of `reviewState`. */
export const PLAN_REVIEW_NUDGE_FOCUS =
  'Your previous plan-review comment on this ticket already reads like a verdict (it started with **APPROVED** or **CHANGES NEEDED**), but `change_status` was never called with `planReviewState` to record it. ' +
  "Read your own last comment, then call `change_status` now (newStatus: \"Grooming\", planReviewState set to match — 'approved' or 'changes-requested'), and end your turn. Do not re-review from scratch.";

// ── Gate spec ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything that differs between gates. Only `PLAN_GATE_SPEC` exists today — the `review` gate's own
 * wiring (a separate sibling ticket) plugs in a second spec rather than touching the driver below.
 */
interface GateRunSpec {
  /** Display label for logs/comments. */
  gate: string;
  /** Task frontmatter field carrying this gate's verdict (parallel to Temper's `reviewState`). */
  verdictField: string;
  /** Durable per-ticket loop flags (parallel to Temper's `tempering` / `temperAttempts`). */
  runningField: string;
  attemptsField: string;
  /** Phase to dispatch for the "revise" step (Temper/`review`: 'implementation'; `plan`: 'grooming'). */
  revisePhase: FurnacePhase | 'grooming';
  /** Neither dispatch needs a worktree/branch for `plan` (no diff exists) — Temper's `review` loop does. */
  skipIsolation: boolean;
  /** Built once per dispatch from the CURRENT ticket (effort/depth may change between passes). */
  reviewFocus: (ticketId: string) => string;
  reviseFocus: string;
  reviewNudgeFocus: string;
  /** The gate's terminal-approved action — a parameter, not hardcoded, so a second gate can supply its
   *  own (`plan`: move Grooming -> Todo; `review`: no-op, Temper's `pr-open` already leaves it at Ready). */
  onApproved: (ticketId: string) => Promise<void>;
  /** Status a parked ticket rests in. Omitted -> `parkTicketOnBoard`'s own default (`inProgressStatus()`). */
  parkStatus?: () => string;
}

/**
 * FLUX-1288: the three shapes a gate run can take, orthogonal to gate value resolution (that mapping —
 * `resolvePlanGateMode` — lives in mcp-server.ts alongside its sibling pure functions).
 *   `one-pass`     -> a manual `start_plan_review` call (any gate value): runs ONE review pass and always
 *                     stops, regardless of verdict.
 *   `loop-confirm` -> `auto-then-you`: loops changes-requested -> revise -> re-review, but an approved
 *                     verdict stops the loop and flags a human to confirm the move to Todo.
 *   `loop-auto`    -> `auto`: loops the same way, but an approved verdict moves Grooming -> Todo itself.
 */
export type PlanGateMode = 'one-pass' | 'loop-confirm' | 'loop-auto';
const PLAN_GATE_MODES: readonly PlanGateMode[] = ['one-pass', 'loop-confirm', 'loop-auto'];

interface GateRunEntry {
  spec: GateRunSpec;
  mode: PlanGateMode;
  ticket: BatchTicket;
  /** FLUX-1303: true while this entry is mid-registration — seeded in the map (so a rapid second
   *  trigger sees `already-running`) but the initial persist + dispatch below haven't finished yet.
   *  `reconcileGateTicket` skips a `starting` entry outright. Without this, the 5s background tick
   *  could observe "active state, no session yet" in that window and independently redrive via
   *  `decideTicketAction`'s `sessionStatus === undefined -> redrive` branch — for `startPlanReviseNow`
   *  specifically, that redrive dispatches the bare `spec.reviseFocus` with NO notes, racing the
   *  notes-bearing dispatch already in flight; whichever `spawnGate` call loses silently drops the
   *  user's notes (the other 409s). `startPlanGateNow`'s equivalent race redrives a byte-identical
   *  review focus, so it was merely a harmless duplicate — closed here too for one shared invariant. */
  starting?: boolean;
}

const gateRuns = new Map<string, GateRunEntry>();

/** True while a gate run is actively driving this ticket (in-memory). */
export function isGateRunning(ticketId: string): boolean {
  return gateRuns.has(ticketId);
}

const GROOMING_STATUS = 'Grooming';

const PLAN_GATE_SPEC: GateRunSpec = {
  gate: 'plan',
  verdictField: 'planReviewState',
  runningField: 'planGateRunning',
  attemptsField: 'planGateAttempts',
  revisePhase: 'grooming',
  skipIsolation: true,
  reviewFocus: (ticketId: string) => {
    const task = tasksCache[ticketId];
    const depth = resolvePlanReviewDepth(task?.effort, configCache.planReviewDepth);
    return planReviewFocus(depth);
  },
  reviseFocus: PLAN_REVISE_FOCUS,
  reviewNudgeFocus: PLAN_REVIEW_NUDGE_FOCUS,
  onApproved: async (ticketId: string) => {
    const todo = nextColumnAfter(GROOMING_STATUS) || 'Todo';
    await updateTaskWithHistory(ticketId, {
      nextStatus: todo,
      extraFields: { planReviewState: null },
      entries: [{
        type: 'activity',
        user: 'Plan Gate',
        comment: `Plan-review gate (auto): approved — moved to ${todo}.`,
        date: nowIso(),
      }],
      updatedBy: 'Plan Gate',
    });
  },
  parkStatus: () => GROOMING_STATUS,
};

// ── Lifecycle helpers ────────────────────────────────────────────────────────────────────────────

async function persistGateAttempts(spec: GateRunSpec, ticketId: string, attempts: number): Promise<void> {
  try {
    await updateTaskWithHistory(ticketId, { extraFields: { [spec.attemptsField]: attempts }, updatedBy: 'Plan Gate' });
  } catch (e: unknown) {
    log.warn(`[gate:${spec.gate}] ${ticketId} persist attempts failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Stop a gate run: drop it from the registry and clear its durable loop fields (leaves the verdict field
 *  untouched — that's what the AttentionDock's plan-approval/gate-parked items read).
 *
 * `needsActionMessage`, when given, is written to `needsAction` UNCONDITIONALLY (not the idempotent
 * `raiseNeedsAction` guard) — a one-shot stop's own review session already ended its turn still sitting
 * in Grooming with no board action, so the generic FLUX-651 backstop (`flagIfParked`) may already have
 * raised a generic "ended its turn without a board action" flag by the time this runs; this overwrites it
 * with the accurate, plan-specific one the AttentionDock/board lane actually want the human to read. */
async function stopGateRun(spec: GateRunSpec, ticketId: string, note?: string, needsActionMessage?: string): Promise<void> {
  gateRuns.delete(ticketId);
  try {
    await updateTaskWithHistory(ticketId, {
      deleteFields: [spec.runningField, spec.attemptsField, 'planGateMode'],
      ...(note ? { entries: [{ type: 'activity', user: 'Plan Gate', comment: note, date: nowIso() }] } : {}),
      ...(needsActionMessage ? { extraFields: { needsAction: needsActionMessage } } : {}),
      updatedBy: 'Plan Gate',
    });
    if (needsActionMessage) {
      const task = tasksCache[ticketId];
      generateNeedsActionNotification(ticketId, task?.title || ticketId, task?.status ?? '', needsActionMessage);
    }
  } catch (e: unknown) {
    log.warn(`[gate:${spec.gate}] ${ticketId} stop persist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function parkGate(spec: GateRunSpec, ticketId: string, reason: string): Promise<void> {
  await parkTicketOnBoard(ticketId, `${spec.gate} review: ${reason}`, { ...(spec.parkStatus ? { status: spec.parkStatus() } : {}) });
  await stopGateRun(spec, ticketId);
  log.info(`[gate:${spec.gate}] ${ticketId} parked: ${reason}`);
}

/** Clear a stale verdict before dispatching a fresh review (mirrors Temper's `clearReviewState`). */
async function clearGateVerdict(spec: GateRunSpec, ticketId: string): Promise<void> {
  const t = tasksCache[ticketId];
  if (t && t[spec.verdictField] != null) {
    try {
      await updateTaskWithHistory(ticketId, { extraFields: { [spec.verdictField]: null }, updatedBy: 'Plan Gate' });
    } catch (e: unknown) {
      log.warn(`[gate:${spec.gate}] clear verdict on ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Dispatch a phase session for a gate run, mirroring Temper's `spawnTemper` minus the worktree-slot
 *  gating (this gate never claims a worktree — `spec.skipIsolation` keeps every dispatch branchless). */
async function spawnGate(entry: GateRunEntry, phase: FurnacePhase | 'grooming', focusComment: string): Promise<void> {
  const { spec, ticket } = entry;
  const { sid } = await dispatchSession(ticket.ticketId, phase, { focusComment, skipIsolation: spec.skipIsolation });
  if (sid) {
    ticket.currentSessionId = sid;
    if (!ticket.sessionIds.includes(sid)) ticket.sessionIds.push(sid);
    ticket.sessionStartedAt = nowIso();
    ticket.spawnFailures = 0;
    return;
  }
  ticket.spawnFailures = (ticket.spawnFailures || 0) + 1;
  if (ticket.spawnFailures >= MAX_GATE_SPAWN_ATTEMPTS) {
    await parkGate(spec, ticket.ticketId, `could not start a ${phase} session after ${MAX_GATE_SPAWN_ATTEMPTS} attempts (the environment may be broken)`);
  }
}

// ── Executor ─────────────────────────────────────────────────────────────────────────────────────

async function advanceGateTicket(ticketId: string, action: TicketAction): Promise<void> {
  const entry = gateRuns.get(ticketId);
  if (!entry) return;
  const { spec, ticket, mode } = entry;
  switch (action.type) {
    case 'wait':
      return;

    case 'review': {
      ticket.state = 'reviewing';
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      ticket.reviewNudgeSent = false;
      await clearGateVerdict(spec, ticketId);
      await spawnGate(entry, 'review', spec.reviewFocus(ticketId));
      break;
    }

    case 'review-nudge': {
      ticket.reviewNudgeSent = true;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await spawnGate(entry, 'review', spec.reviewNudgeFocus);
      log.info(`[gate:${spec.gate}] ${ticketId} review left a verdict-shaped comment without change_status — nudging instead of parking.`);
      break;
    }

    case 'reimplement': {
      // FLUX-1288: only a genuine one-pass run never loops — a changes-requested verdict from the
      // single pass just sits recorded, flagged for a human. `loop-confirm` (`auto-then-you`) and
      // `loop-auto` (`auto`) both dispatch the revise pass and re-review automatically.
      if (mode === 'one-pass') {
        await stopGateRun(
          spec, ticketId,
          `${spec.gate} gate (one pass): changes requested — flagged for you; Auto→You never auto-revises.`,
          `Plan reviewed — verdict: changes requested. Open the plan to read the feedback and confirm your next step.`,
        );
        break;
      }
      ticket.state = 'reimplementing';
      ticket.attempts = action.attempt;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await persistGateAttempts(spec, ticketId, action.attempt);
      await spawnGate(entry, spec.revisePhase, spec.reviseFocus);
      break;
    }

    case 'redrive': {
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      const isReview = action.phase === 'review';
      const focus = isReview ? spec.reviewFocus(ticketId) : (ticket.state === 'reimplementing' ? spec.reviseFocus : spec.reviewFocus(ticketId));
      await spawnGate(entry, isReview ? 'review' : spec.revisePhase, focus);
      break;
    }

    case 'pr-open': {
      // FLUX-1288: `loop-auto` (`auto`) is the only mode that auto-moves on approval. `one-pass` and
      // `loop-confirm` (`auto-then-you`) both stop and flag a human to confirm — `loop-confirm` just got
      // there by looping first, so the human is confirming a plan the automation already iterated on.
      if (mode === 'loop-auto') {
        await spec.onApproved(ticketId);
        await stopGateRun(spec, ticketId);
        break;
      }
      const note = mode === 'one-pass'
        ? `${spec.gate} gate (one pass): approved — flagged for you to confirm; Auto→You never loops.`
        : `${spec.gate} gate: approved after looping — flagged for you to confirm the move to Todo.`;
      await stopGateRun(
        spec, ticketId, note,
        `Plan reviewed — verdict: approved. Confirm to move this ticket to Todo.`,
      );
      break;
    }

    case 'park': {
      await parkGate(spec, ticketId, action.reason);
      break;
    }

    // Never produced (rate-limit/context-exhaustion inputs are omitted below) — ignored defensively.
    case 'retry-exhausted':
    case 'cooldown-rate-limited':
    case 'retry-rate-limited':
      return;
  }
}

// ── Reconcile ────────────────────────────────────────────────────────────────────────────────────

async function reconcileGateTicket(ticketId: string): Promise<void> {
  const entry = gateRuns.get(ticketId);
  if (!entry) return;
  if (entry.starting) return; // mid-registration — see `GateRunEntry.starting`
  const { spec, ticket } = entry;

  // FLUX-1263: preserves Temper's exact "yield to an active Furnace batch" precedence (AC #7 there).
  if (isTicketInActiveFurnaceBatch(ticketId)) {
    await stopGateRun(spec, ticketId, `${spec.gate} gate yielded — this ticket is now driven by an active Furnace batch.`);
    log.info(`[gate:${spec.gate}] ${ticketId} now owned by an active Furnace batch — yielding.`);
    return;
  }
  // FLUX-1303: the plan gate only owns Grooming tickets — if a human (board drag, Approve anyway)
  // or an agent moved the ticket out of Grooming while a run was in flight, stop the run instead of
  // driving a re-review against a Todo/In-Progress ticket (whose reviewer would then yank it back
  // to Grooming via its verdict-recording change_status, or park it there via parkStatus).
  const currentTask = tasksCache[ticketId];
  if (currentTask && currentTask.status !== GROOMING_STATUS) {
    await stopGateRun(spec, ticketId, `${spec.gate} gate stopped — the ticket left ${GROOMING_STATUS} (now ${currentTask.status}) while a run was in flight.`);
    log.info(`[gate:${spec.gate}] ${ticketId} left ${GROOMING_STATUS} mid-run — stopping.`);
    return;
  }
  if (!isActiveTicketState(ticket.state)) return;

  const currentPhase: FurnacePhase | 'grooming' = ticket.state === 'reviewing' ? 'review' : spec.revisePhase;
  let sess = ticket.currentSessionId ? cliSessionsById.get(ticket.currentSessionId) : undefined;
  if (!sess) sess = pickSessionForPhase(getActiveSessionsForTask(ticketId), currentPhase);
  if (sess && sess.id !== ticket.currentSessionId) {
    ticket.currentSessionId = sess.id;
    if (!ticket.sessionIds.includes(sess.id)) ticket.sessionIds.push(sess.id);
    if (!ticket.sessionStartedAt) ticket.sessionStartedAt = nowIso();
  }

  const task = tasksCache[ticketId];
  const verdict = (task?.[spec.verdictField] ?? null) as 'approved' | 'changes-requested' | null;
  const sessionOutcome = findSessionOutcome(task, sess?.id ?? ticket.currentSessionId);
  const action = decideTicketAction({
    ticket,
    ...(sess ? { sessionStatus: sess.status } : {}),
    // Deliberately NOT passing terminalReason — a gate run parks on rate/context limits, same as Temper.
    ...(sessionOutcome ? { sessionOutcome } : {}),
    reviewState: verdict,
    ...(task?.status ? { ticketStatus: task.status } : {}),
    ...(configCache.requireInputStatus ? { requireInputStatus: configCache.requireInputStatus } : {}),
    retryCap: DEFAULT_RETRY_CAP,
    reviewVerdictMarkerSeen: lastCommentMatchesVerdictMarker(task?.history, ticket.sessionStartedAt),
  });
  await advanceGateTicket(ticketId, action);
}

// ── Trigger (manual entry point + the `change_status` guard's redirect) ────────────────────────────

/**
 * Start a plan-review run right now. Used both by the `start_plan_review` MCP tool (always
 * `mode: 'one-pass'`, regardless of gate value) and by the `change_status` guard's redirect for
 * `auto`/`auto-then-you` (via `resolvePlanGateMode` in mcp-server.ts, which picks `loop-auto`/`loop-confirm`).
 *
 * FLUX-1269: `reason` discriminates the `ok: false` cases so callers can tell a benign refusal (a pass is
 * already genuinely running — the "runs instead" story is still true) from one where nothing started at
 * all (the caller must not report success, and — for the `change_status` redirect — should let the
 * ordinary status move proceed instead of leaving the ticket wedged).
 */
/** Shared refusal checks for BOTH plan-gate entry points (review pass + revise) — the checks are
 *  identical by design and must stay identical, so new preconditions land HERE, not in one caller.
 *  `kind` only picks the message wording. Returns null when the start may proceed. */
function planGateStartRefusal(
  ticketId: string,
  kind: 'review' | 'revise',
): { ok: false; message: string; reason: 'not-found' | 'wrong-status' | 'already-running' | 'furnace-owned' } | null {
  const task = tasksCache[ticketId];
  if (!task) return { ok: false, message: `Ticket ${ticketId} not found.`, reason: 'not-found' };
  if (task.status !== GROOMING_STATUS) {
    const verb = kind === 'review' ? 'the plan-review gate only runs' : 'a plan revise only runs';
    return { ok: false, message: `${ticketId} is not in ${GROOMING_STATUS} — ${verb} on a Grooming ticket.`, reason: 'wrong-status' };
  }
  if (gateRuns.has(ticketId)) {
    const flight = kind === 'review' ? 'a plan-review pass' : 'a plan-gate run';
    return { ok: false, message: `${ticketId} already has ${flight} in flight.`, reason: 'already-running' };
  }
  if (isTicketInActiveFurnaceBatch(ticketId)) {
    return { ok: false, message: `${ticketId} is owned by an active Furnace batch — it wins; the plan${kind === 'review' ? '-review' : ''} gate won't double-drive it.`, reason: 'furnace-owned' };
  }
  return null;
}

export async function startPlanGateNow(
  ticketId: string,
  opts: { mode: PlanGateMode },
): Promise<{ ok: boolean; message: string; reason?: 'not-found' | 'wrong-status' | 'already-running' | 'furnace-owned' }> {
  const refusal = planGateStartRefusal(ticketId, 'review');
  if (refusal) return refusal;

  const spec = PLAN_GATE_SPEC;
  const { mode } = opts;
  // Seed the registry SYNCHRONOUSLY (before any await) so a rapid second trigger can't double-start —
  // mirrors `maybeStartTemper`'s exact race-closing idiom. `starting: true` also blocks the
  // background tick from redriving this ticket while the persist + initial dispatch below are still
  // in flight (FLUX-1303 — see `GateRunEntry.starting`).
  const entry: GateRunEntry = { spec, mode, ticket: { ticketId, order: 0, state: 'reviewing', attempts: 0, sessionIds: [] }, starting: true };
  gateRuns.set(ticketId, entry);
  try {
    try {
      await updateTaskWithHistory(ticketId, {
        extraFields: { [spec.runningField]: true, [spec.attemptsField]: 0, planGateMode: mode },
        entries: [{
          type: 'activity',
          user: 'Plan Gate',
          comment: mode === 'one-pass'
            ? 'Plan-review gate — running one automated review pass (never loops).'
            : mode === 'loop-auto'
            ? `Plan-review gate on — looping review → revise until approved, or parking after ${DEFAULT_RETRY_CAP} revise attempt(s).`
            : `Plan-review gate on — looping review → revise until approved (approval flags you to confirm), or parking after ${DEFAULT_RETRY_CAP} revise attempt(s).`,
          date: nowIso(),
        }],
        updatedBy: 'Plan Gate',
      });
    } catch (e: unknown) {
      log.warn(`[gate:plan] ${ticketId} start persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await advanceGateTicket(ticketId, { type: 'review' });
  } finally {
    entry.starting = false;
  }
  const dispatched = !!gateRuns.get(ticketId)?.ticket.currentSessionId;
  return {
    ok: true,
    message: dispatched
      ? `Plan-review pass dispatched for ${ticketId}.`
      : `Plan-review requested for ${ticketId} — waiting for a session to become available.`,
  };
}

/**
 * FLUX-1303: "Send for re-grooming" — the atomic revise entry point behind
 * `POST /api/tasks/:id/plan-review/revise`. Replaces the portal's old two-step flow (dispatch a
 * grooming session, then a follow-up PUT to clear the verdict) that could strand a stale
 * `changes-requested` card when the second call failed, and whose dispatched session was invisible
 * to this runner — so the revise focus's "the gate automatically re-reviews your revision" promise
 * was false for portal-dispatched revises.
 *
 * In ONE operation: persists the user's notes as an attributed `comment` (server-side append —
 * immune to the stale-snapshot full-history replace that ate the FLUX-1298 send-back notes), stamps
 * the verdict `changes-requested` (a revise of an `approved` plan is a human override consuming the
 * approval; surfaces key their "Revising…" state off changes-requested + `planGateRunning`, exactly
 * like the loop's own reimplementing phase), records `planReviewBodyHash`, dispatches the grooming
 * session seeded with the reviewer feedback pointer AND the notes, and registers the run in the
 * gate registry in the `reimplementing` state — so the ordinary tick loop re-reviews the revision
 * when the session completes.
 *
 * Mode: resolved from the ticket's effective `plan` gate value via `planGateModeForRevise`
 * (models/gate-policy.ts — kept beside `resolvePlanGateMode`'s redirect mapping so the two can't
 * silently drift): `auto`/`auto-then-you` keep their loop semantics; `you` maps to `one-pass` —
 * the human explicitly asked for this revise, so the revision earns exactly ONE automatic
 * re-review, then the runner stops and flags the human whichever way the verdict lands.
 *
 * Overriding an `approved` verdict REQUIRES notes (server-enforced, not just the portal buttons —
 * a bare REST call must not silently flip an approval with no stated reason). A failed persist
 * ABORTS the whole revise (registry dropped, nothing dispatched, `ok: false`) — proceeding would
 * recreate the exact lost-notes/stale-card class this endpoint exists to fix.
 */
export async function startPlanReviseNow(
  ticketId: string,
  opts: { notes?: string; user?: string } = {},
): Promise<{ ok: boolean; message: string; reason?: 'not-found' | 'wrong-status' | 'already-running' | 'furnace-owned' | 'notes-required' | 'persist-failed' }> {
  const refusal = planGateStartRefusal(ticketId, 'revise');
  if (refusal) return refusal;
  const task = tasksCache[ticketId]!;

  const spec = PLAN_GATE_SPEC;
  const gateValue = resolveGateValue(configCache.gatePolicy, task.gatePolicyOverride, 'plan');
  const mode: PlanGateMode = planGateModeForRevise(gateValue);
  const user = opts.user?.trim() || 'User';
  const notes = opts.notes?.trim() || '';

  if (task[spec.verdictField] === 'approved' && !notes) {
    return {
      ok: false,
      message: `${ticketId} has an APPROVED plan verdict — overriding it requires notes stating what should change.`,
      reason: 'notes-required',
    };
  }

  // Seed the registry SYNCHRONOUSLY (before any await) — same race-closing idiom as startPlanGateNow.
  // `starting: true` additionally blocks the background tick from redriving this ticket with a
  // notes-FREE `redrive` while the notes-bearing dispatch below is still in flight (FLUX-1303 — see
  // `GateRunEntry.starting`; unlike the review-pass redrive, a raced revise redrive uses a genuinely
  // DIFFERENT — notes-less — focus, so losing that race silently drops the user's notes).
  const entry: GateRunEntry = { spec, mode, ticket: { ticketId, order: 0, state: 'reimplementing', attempts: 1, sessionIds: [] }, starting: true };
  gateRuns.set(ticketId, entry);
  try {
    await updateTaskWithHistory(ticketId, {
      extraFields: {
        [spec.runningField]: true,
        [spec.attemptsField]: 1,
        planGateMode: mode,
        [spec.verdictField]: 'changes-requested',
        planReviewBodyHash: planBodyHash(typeof task.body === 'string' ? task.body : ''),
        needsAction: null,
        // A prior gate park leaves the require-input swimlane set — the revise IS the human's
        // answer, so clear it rather than keeping a stale "needs input" lane over a live session.
        ...(task.swimlane === 'require-input' ? { swimlane: null } : {}),
      },
      entries: [
        ...(task.swimlane === 'require-input'
          ? [{ type: 'swimlane_change' as const, swimlane: 'require-input', action: 'cleared', user: 'Plan Gate', date: nowIso() }]
          : []),
        ...(notes ? [{ type: 'comment' as const, user, comment: notes, date: nowIso() }] : []),
        {
          type: 'activity' as const,
          user: 'Plan Gate',
          comment: notes
            ? `Sent for re-grooming by ${user} (notes above) — a grooming session is revising the plan; the gate re-reviews the revision.`
            : `Sent for re-grooming by ${user} — a grooming session is revising the plan against the review feedback; the gate re-reviews the revision.`,
          date: nowIso(),
        },
      ],
      updatedBy: user,
    });
  } catch (e: unknown) {
    // ABORT — dispatching anyway would run a revise session against a ticket whose durable record
    // (notes comment, verdict, running flag) never landed: the board would show live Approve
    // buttons while an agent rewrites the plan, and the user's notes would exist only inside the
    // ephemeral session focus. The caller keeps the composer content and can simply retry.
    gateRuns.delete(ticketId);
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`[gate:plan] ${ticketId} revise persist failed — aborted, nothing dispatched: ${msg}`);
    return { ok: false, message: `Could not record the re-groom on ${ticketId} (${msg}) — nothing was dispatched; try again.`, reason: 'persist-failed' };
  }
  // `starting` still true here — held through the dispatch below, so the tick can't redrive with a
  // notes-less focus while this notes-bearing one is in flight. Cleared in `finally` no matter how
  // `spawnGate` resolves (including a spawn failure that parks the ticket and deletes the entry —
  // mutating the local `starting` flag on an already-discarded object is harmless).
  try {
    const focus = notes
      ? `${spec.reviseFocus}\n\nThe user attached these notes for this revision — address every point in them too (verbatim, from the human):\n${notes}`
      : spec.reviseFocus;
    await spawnGate(entry, spec.revisePhase, focus);
  } finally {
    entry.starting = false;
  }
  const dispatched = !!gateRuns.get(ticketId)?.ticket.currentSessionId;
  return {
    ok: true,
    message: dispatched
      ? `Revise session dispatched for ${ticketId} — the gate re-reviews the revision${mode === 'one-pass' ? ' once, then flags you' : ''}.`
      : `Revise requested for ${ticketId} — waiting for a session to become available.`,
  };
}

// ── Tick orchestration ──────────────────────────────────────────────────────────────────────────

let ticking = false;

/** Advance every actively-running gate ticket by one tick. Never overlaps itself. */
export async function gateRunnerTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const ticketId of [...gateRuns.keys()]) {
      try {
        await reconcileGateTicket(ticketId);
      } catch (e: unknown) {
        log.error(`[gate] tick for ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    ticking = false;
  }
}

/** Restore the in-memory registry from durable frontmatter after an engine restart (mirrors `rehydrateTemper`). */
export function rehydrateGateRunner(): void {
  const spec = PLAN_GATE_SPEC;
  for (const id of Object.keys(tasksCache)) {
    const t = tasksCache[id];
    if (t?.[spec.runningField] === true && !gateRuns.has(id)) {
      const attempts = typeof t[spec.attemptsField] === 'number' ? t[spec.attemptsField] : 0;
      // FLUX-1288: a ticket already mid-loop when this upgrade deploys still carries the legacy boolean
      // frontmatter field — map it to the mode with equivalent semantics rather than losing it.
      const mode: PlanGateMode = PLAN_GATE_MODES.includes(t.planGateMode as PlanGateMode)
        ? (t.planGateMode as PlanGateMode)
        : t.planGateOneShot === true ? 'one-pass' : 'loop-auto';
      // FLUX-1303: restore the phase from any surviving session rather than assuming 'reviewing' —
      // a run rehydrated mid-REVISE as 'reviewing' would redrive a plan-review session concurrently
      // with the still-running grooming revise (two agents writing the same ticket at once).
      const liveRevise = pickSessionForPhase(getActiveSessionsForTask(id), spec.revisePhase);
      const state = liveRevise ? ('reimplementing' as const) : ('reviewing' as const);
      gateRuns.set(id, { spec, mode, ticket: { ticketId: id, order: 0, state, attempts, sessionIds: [] } });
      log.info(`[gate:${spec.gate}] rehydrated ${id} (attempts ${attempts}, mode ${mode}, state ${state}) — will re-drive on the next tick.`);
    }
  }
}

let gateTimer: ReturnType<typeof setInterval> | null = null;

/** Start the background gate-runner loop (idempotent). Rehydrates first so a restart resumes in-flight runs. */
export function startGateRunnerLoop(): void {
  if (gateTimer) return;
  rehydrateGateRunner();
  gateTimer = setInterval(() => { void gateRunnerTick(); }, GATE_RUNNER_INTERVAL_MS);
  gateTimer.unref?.();
  log.info('[gate] plan-review runner loop started.');
}

export function stopGateRunnerLoop(): void {
  if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
}

/** Test-only: clear the in-memory loop registry between cases (the map is process-lived in production). */
export function __resetGateRunnerForTests(): void {
  gateRuns.clear();
  ticking = false;
}
