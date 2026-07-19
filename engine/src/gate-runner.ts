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

import { getWorkspace, getDefaultWorkspace, liveWorkspaces, runWithWorkspace, type Workspace } from './workspace-context.js';
import { log } from './log.js';
import { buildActivityEntry, buildCommentEntry } from './history.js';
import { nextColumnAfter, getConfig } from './config.js';
import { updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { generateNeedsActionNotification, generatePlanAutoApprovedNotification } from './notifications.js';
import { cliSessionsById, getActiveSessionsForTaskInWorkspace } from './session-store.js';
import { isActiveTicketState, DEFAULT_RETRY_CAP, type BatchTicket, type FurnacePhase } from './models/furnace.js';
import { planBodyHash, planGateModeForRevise, resolveGateValue, resolvePlanReviewDepth, type PlanReviewDepth } from './models/gate-policy.js';
import { planLint, formatLintFindings } from './models/plan-lint.js';
import { listArtifactRevisionsOnDisk } from './artifacts.js';
import { isTicketInActiveFurnaceBatch } from './temper.js';
import {
  decideTicketAction,
  dispatchSession,
  resumeOrDispatchSession,
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

// FLUX-1469: these five checks used to carry their full methodology paragraph inline — pushed
// into every gate dispatch AND re-persisted verbatim into ticket history on every pass (the
// "~2.4KB static launch-focus" this ticket fixes). Each is now a one-line imperative stub; the
// full method lives in the ORCHESTRATOR module's "## Plan-review methodology" section, pulled on
// demand via `read_skill('orchestrator', 'Plan-review methodology')` — named once, up front, in
// `planReviewFocus` below rather than repeated on every stub. Deliberately NOT the review module:
// review-phase sessions (including the gate's own — spawnGate dispatches phase 'review') get that
// module INJECTED at spawn, so parking the methodology there would push it into every code-review
// prelude instead of keeping it a genuine on-demand pull.

/** Exported for tests (FLUX-1469): assert each one-line stub survives the split (stub integrity). */
export const ANCHOR_CHECK =
  'Anchor check: verify every cited file/symbol/line still exists and means what the plan says — re-derive fresh every pass, never trust a prior citation.';

export const REGROUND_CHECK =
  'Reground (FLUX-1048): check `.docs/release-notes/INDEX.md` + sibling/recently-Done tickets for work that already landed part of this plan.';

export const AC_COVERAGE_CHECK =
  'Acceptance-criteria coverage: confirm the AC checklist is testable and every item is addressed by the plan.';

export const DUPLICATE_CHECK =
  'Duplicate check: search open/groomed tickets for one that already covers this same scope.';

/** FLUX-1480: PR #584's two Majors (methodology parked in an INJECTED module; `tools` added to the
 *  concatenated constant) both planted at ticket-writing time and survived four consistency-checking
 *  stages because every stage checked "does X match the stage before?" — none re-derived who actually
 *  consumes the plan's chosen destination. This check forces that re-derivation at review time. */
export const CONSEQUENCE_CHECK =
  "Consequence tracing: for every destination this plan moves content/config into, name who consumes it and confirm the move still serves the plan's goal.";

export const ADVERSARIAL_CHECK =
  "Adversarial self-review: read the plan as its harshest critic — flag weak/missing/wrong steps, unstated hard-to-reverse decisions, and judgment calls the plan ducked.";

/** FLUX-1379: `hasArtifact` is now a deterministic fact injected by the lint pass (`listArtifactRevisionsOnDisk`),
 *  not something the reviewer has to go check itself — the check keeps its "flag, not a blocker" judgment
 *  half (whether the plan is UI/UX-shaped enough to WARRANT one), since that's the half a linter can't do. */
function artifactCheckText(hasArtifact: boolean): string {
  return hasArtifact
    ? 'Artifact check (FLUX-1313): a plan artifact revision has already been published for this ticket (confirmed deterministically by the pre-gate lint) — no gap here regardless of how UI/UX-shaped the plan reads.'
    : 'Artifact check (FLUX-1313): no `publish_artifact` revision exists for this ticket (confirmed deterministically by the pre-gate lint). If this plan is UI/UX-shaped (visual layout, a new component, an interaction change), flag it in the review comment as a gap — do not approve silently. This is a flag, not a blocker: note it and still record your verdict on the plan\'s own merits.';
}

/** Exported for tests (FLUX-1469): assert this exact string is present verbatim in every dispatched
 *  plan-review focus at every depth — the hard constraint that must never move behind a pull. */
export const PLAN_VERDICT_CONTRACT =
  'Record your verdict via `change_status` — leave `newStatus` as "Grooming" (do NOT move the ticket) and set `planReviewState` to "approved" or "changes-requested" (never `reviewState`; that is a different field for the post-Todo code-review gate). ' +
  'Posting a comment that starts with **APPROVED** or **CHANGES NEEDED** is not enough by itself — without the `change_status` call the ticket will be parked for a human over an unrecorded verdict.';

/** FLUX-1379: deterministic lint (`models/plan-lint.ts`) already ran ahead of this session — any bounce
 *  finding would have refused the move before a session was ever dispatched, so only WARN findings (e.g.
 *  W1, no artifact) can still be here. Handed to the reviewer as already-known facts, not new work. */
function lintFocusBlock(warnFindingsText: string): string {
  if (!warnFindingsText) return '';
  return ` Deterministic lint already ran and flagged this (non-blocking — already reflected in the artifact check above where applicable):\n${warnFindingsText}`;
}

/** Named once, up front, so every stub below can say "detail above" instead of each repeating the
 *  same pull call (FLUX-1469). Exported for tests: assert the exact pull call the stubs promise. */
export const METHODOLOGY_PULL_POINTER = "Full method for each check below: `read_skill('orchestrator', 'Plan-review methodology')`.";

/** The focus handed to a plan-review session, scaled to the resolved depth (Quick/Standard/Thorough)
 *  and the deterministic lint's findings (FLUX-1379) — `hasArtifact` reworks the artifact check from a
 *  reviewer chore into a consumed fact; `warnFindingsText` (pre-formatted via `formatLintFindings`) is
 *  appended verbatim so the reviewer doesn't re-derive what the lint already found. FLUX-1469: the
 *  checks themselves are now one-line stubs — full methodology is pulled via `read_skill`, not pushed
 *  (and re-persisted into history) on every pass; only the verdict contract and the dynamic facts
 *  (depth, artifact fact, lint findings) stay pushed verbatim. */
export function planReviewFocus(depth: PlanReviewDepth, hasArtifact: boolean, warnFindingsText = ''): string {
  const checks = [ANCHOR_CHECK, artifactCheckText(hasArtifact)];
  if (depth === 'standard' || depth === 'thorough') checks.push(REGROUND_CHECK, AC_COVERAGE_CHECK, CONSEQUENCE_CHECK);
  if (depth === 'thorough') checks.push(DUPLICATE_CHECK, ADVERSARIAL_CHECK);
  return `${PLAN_REVIEW_BASE} Depth: ${depth}. ${METHODOLOGY_PULL_POINTER} ${checks.join(' ')} ${PLAN_VERDICT_CONTRACT}${lintFocusBlock(warnFindingsText)}`;
}

/** The focus for a "revise the plan" pass after a plan-review pass requested changes. */
export const PLAN_REVISE_FOCUS =
  "A plan-review pass just requested changes on this ticket's plan (see the latest review comment in its history) — revise the ticket body via `update_ticket` to address every point raised, then STOP. " +
  'Do not call `change_status` yourself and do not start implementing; the plan-review gate automatically re-reviews your revision. ' +
  'When revising an artifact: revise minimally — answer every annotation explicitly, show the annotated element before→after, and never silently redesign elements the user already approved.';

/** Mirrors Temper's `REVIEW_NUDGE_FOCUS`, keyed to `planReviewState` instead of `reviewState`. */
export const PLAN_REVIEW_NUDGE_FOCUS =
  'Your previous plan-review comment on this ticket already reads like a verdict (it started with **APPROVED** or **CHANGES NEEDED**), but `change_status` was never called with `planReviewState` to record it. ' +
  "Read your own last comment, then call `change_status` now (newStatus: \"Grooming\", planReviewState set to match — 'approved' or 'changes-requested'), and end your turn. Do not re-review from scratch.";

/** FLUX-1437: mirrors Temper's `REVIEW_RETRY_FOCUS`, keyed to `planReviewState` instead of `reviewState`
 *  — the one-shot corrective focus for a plan-review pass that ended with NO verdict AND no
 *  verdict-shaped comment either (e.g. narrated a dead background/monitor wait instead of calling
 *  `change_status`). */
export const PLAN_REVIEW_RETRY_FOCUS =
  'Your previous plan-review session for this ticket ended without ever calling `change_status` to record a verdict, and without leaving a verdict-shaped comment either — so the ticket was about to be parked for a human over that alone. ' +
  'Give it a fresh review pass now: assess the plan, then call `change_status` (newStatus: "Grooming", planReviewState set to "approved" or "changes-requested" to match your verdict), and end your turn. If you genuinely cannot decide, use "Require Input" instead of ending the turn without a verdict again.';

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
  /** Built once per dispatch from the CURRENT ticket (effort/depth may change between passes). Async
   *  since FLUX-1379 — it reads the deterministic lint's findings off disk (artifact revisions). */
  reviewFocus: (ticketId: string) => Promise<string>;
  reviseFocus: string;
  reviewNudgeFocus: string;
  /** FLUX-1437: focus for the one-shot retry when a review pass ends with no verdict AND no
   *  verdict-shaped comment (mirrors Temper's `REVIEW_RETRY_FOCUS`). */
  reviewRetryFocus: string;
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
  /** FLUX-1548: the workspace that owns this run — see the module-level registry doc comment below. */
  ws: Workspace;
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

/**
 * FLUX-1548: keyed by workspace root FIRST, ticket id second — mirrors `temper.ts`'s `temperTickets`.
 * Two boards share the `FLUX-` prefix, so the same ticket id can be running a plan-review gate
 * independently on each; a bare `Map<ticketId, GateRunEntry>` would let one board's run silently
 * overwrite/adopt the other's.
 */
const gateRuns = new Map<string, Map<string, GateRunEntry>>();

function wsKey(ws: Workspace): string {
  return ws.root ?? '';
}

function ticketsFor(ws: Workspace): Map<string, GateRunEntry> {
  let m = gateRuns.get(wsKey(ws));
  if (!m) { m = new Map(); gateRuns.set(wsKey(ws), m); }
  return m;
}

function getEntry(ticketId: string, ws: Workspace = getWorkspace()): GateRunEntry | undefined {
  return gateRuns.get(wsKey(ws))?.get(ticketId);
}

/** True while a gate run is actively driving this ticket (in-memory). Scoped to `ws` (default:
 *  whichever workspace is bound in the calling context) so a same-id ticket on a different board
 *  never reads as running here. */
export function isGateRunning(ticketId: string, ws: Workspace = getWorkspace()): boolean {
  return !!getEntry(ticketId, ws);
}

const GROOMING_STATUS = 'Grooming';

const PLAN_GATE_SPEC: GateRunSpec = {
  gate: 'plan',
  verdictField: 'planReviewState',
  runningField: 'planGateRunning',
  attemptsField: 'planGateAttempts',
  revisePhase: 'grooming',
  skipIsolation: true,
  reviewFocus: async (ticketId: string) => {
    const task = getWorkspace().tasks[ticketId];
    const depth = resolvePlanReviewDepth(task?.effort, getConfig().planReviewDepth);
    // FLUX-1379: bounce findings can never reach here — the `change_status`/`start_plan_review`
    // guards already refuse the move before a session dispatches. Only warns (e.g. W1) survive to
    // be injected, plus the deterministic `hasArtifact` fact that reworks the artifact check.
    const hasArtifact = (await listArtifactRevisionsOnDisk(ticketId)).length > 0;
    const lint = planLint({ body: typeof task?.body === 'string' ? task.body : '', effort: task?.effort ?? null, hasArtifact });
    return planReviewFocus(depth, hasArtifact, formatLintFindings(lint.warns));
  },
  reviseFocus: PLAN_REVISE_FOCUS,
  reviewNudgeFocus: PLAN_REVIEW_NUDGE_FOCUS,
  reviewRetryFocus: PLAN_REVIEW_RETRY_FOCUS,
  onApproved: async (ticketId: string) => {
    const todo = nextColumnAfter(GROOMING_STATUS) || 'Todo';
    const title = getWorkspace().tasks[ticketId]?.title;
    await updateTaskWithHistory(ticketId, {
      nextStatus: todo,
      // FLUX-1306: null the reviewed-body hash alongside the verdict — every other verdict-clearing
      // path (mcp-server.ts change_status, dismissPlanReview, approvePlanToTodo, the panel's
      // handleApprove) already does this; leaving it stale here would violate that invariant even
      // though nothing currently reads the hash once planReviewState is null.
      extraFields: { planReviewState: null, planReviewBodyHash: null },
      entries: [{
        type: 'activity',
        user: 'Plan Gate',
        comment: `Plan-review gate (auto): approved — moved to ${todo}.`,
        date: nowIso(),
      }],
      updatedBy: 'Plan Gate',
    });
    // FLUX-1485: unlike the portal PUT route and MCP change_status, updateTaskWithHistory itself
    // never broadcasts — the caller owns it. This auto-consume path had none, so a still-rendered
    // Approve card (dock/chat/panel) never learned its verdict was consumed until an unrelated
    // mutation happened to bump tasksVersion; clicking it in the meantime hit the FLUX-1485 hang.
    broadcastEvent('taskUpdated', { id: ticketId });
    // FLUX-1363: `loop-auto` is the only gate mode that never surfaces the plan to the user (the
    // `one-pass`/`loop-confirm` branches in `advanceGateTicket`'s 'pr-open' case both raise a 'prompt'
    // notification asking for confirmation) — give it a passive FYI instead.
    generatePlanAutoApprovedNotification(ticketId, title || ticketId);
  },
  parkStatus: () => GROOMING_STATUS,
};

// ── Lifecycle helpers ────────────────────────────────────────────────────────────────────────────

async function persistGateAttempts(spec: GateRunSpec, ticketId: string, attempts: number, ws: Workspace): Promise<void> {
  try {
    await updateTaskWithHistory(ticketId, { extraFields: { [spec.attemptsField]: attempts }, updatedBy: 'Plan Gate' }, ws);
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
 * with the accurate, plan-specific one the AttentionDock/board lane actually want the human to read.
 * (On the FLUX-1320 eager path the order inverts — this runs while the review session is still alive —
 * and `flagIfParked` defers to an already-set flag instead, so the specific message wins either way.) */
async function stopGateRun(spec: GateRunSpec, ticketId: string, ws: Workspace, note?: string, needsActionMessage?: string): Promise<void> {
  gateRuns.get(wsKey(ws))?.delete(ticketId);
  try {
    await updateTaskWithHistory(ticketId, {
      deleteFields: [spec.runningField, spec.attemptsField, 'planGateMode'],
      ...(note ? { entries: [{ type: 'activity', user: 'Plan Gate', comment: note, date: nowIso() }] } : {}),
      ...(needsActionMessage ? { extraFields: { needsAction: needsActionMessage } } : {}),
      updatedBy: 'Plan Gate',
    }, ws);
    if (needsActionMessage) {
      const task = ws.tasks[ticketId];
      generateNeedsActionNotification(ticketId, task?.title || ticketId, task?.status ?? '', needsActionMessage);
    }
  } catch (e: unknown) {
    log.warn(`[gate:${spec.gate}] ${ticketId} stop persist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function parkGate(spec: GateRunSpec, ticketId: string, reason: string, ws: Workspace): Promise<void> {
  await parkTicketOnBoard(ticketId, `${spec.gate} review: ${reason}`, { ...(spec.parkStatus ? { status: spec.parkStatus() } : {}) });
  await stopGateRun(spec, ticketId, ws);
  log.info(`[gate:${spec.gate}] ${ticketId} parked: ${reason}`);
}

/** Clear a stale verdict before dispatching a fresh review (mirrors Temper's `clearReviewState`). */
async function clearGateVerdict(spec: GateRunSpec, ticketId: string, ws: Workspace): Promise<void> {
  const t = ws.tasks[ticketId];
  if (t && t[spec.verdictField] != null) {
    try {
      await updateTaskWithHistory(ticketId, { extraFields: { [spec.verdictField]: null }, updatedBy: 'Plan Gate' }, ws);
    } catch (e: unknown) {
      log.warn(`[gate:${spec.gate}] clear verdict on ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Dispatch a phase session for a gate run, mirroring Temper's `spawnTemper` minus the worktree-slot
 *  gating (this gate never claims a worktree — `spec.skipIsolation` keeps every dispatch branchless).
 *  FLUX-1378: `useResume` is true only for a REVISE dispatch (resumes the groomer with warm context on
 *  its own prior plan-review feedback) — a review dispatch always stays fresh (`useResume: false`), per
 *  the plan's independence policy: a reviewer resuming its own session would anchor on its own prior
 *  verdict instead of judging the revision on its own merits. */
async function spawnGate(entry: GateRunEntry, phase: FurnacePhase | 'grooming', focusComment: string, useResume = false): Promise<void> {
  const { spec, ticket, ws } = entry;
  // FLUX-1373: this module ONLY drives the plan gate (see file header) — so every 'review' dispatch
  // here IS the plan gate's own review pass, never Temper's separate code-review pass (a different
  // module, temper.ts, which calls dispatchSession with no taskKey override and so derives the
  // ordinary `review.lead` via deriveTaskKey's phase+position rule). Pin `planReview` explicitly;
  // the 'grooming' revise-pass dispatch is left alone (derives `grooming.lead` normally).
  const taskKey = phase === 'review' ? 'planReview' : undefined;
  const { sid } = useResume
    ? await resumeOrDispatchSession(ticket.ticketId, phase, { focusComment, skipIsolation: spec.skipIsolation, resumeMessage: focusComment, workspaceRoot: ws.root })
    : await dispatchSession(ticket.ticketId, phase, { focusComment, skipIsolation: spec.skipIsolation, workspaceRoot: ws.root, ...(taskKey ? { taskKey } : {}) });
  if (sid) {
    ticket.currentSessionId = sid;
    if (!ticket.sessionIds.includes(sid)) ticket.sessionIds.push(sid);
    ticket.sessionStartedAt = nowIso();
    ticket.spawnFailures = 0;
    return;
  }
  ticket.spawnFailures = (ticket.spawnFailures || 0) + 1;
  if (ticket.spawnFailures >= MAX_GATE_SPAWN_ATTEMPTS) {
    await parkGate(spec, ticket.ticketId, `could not start a ${phase} session after ${MAX_GATE_SPAWN_ATTEMPTS} attempts (the environment may be broken)`, ws);
  }
}

// ── Executor ─────────────────────────────────────────────────────────────────────────────────────

async function advanceGateTicket(ticketId: string, ws: Workspace, action: TicketAction): Promise<void> {
  const entry = getEntry(ticketId, ws);
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
      await clearGateVerdict(spec, ticketId, ws);
      await spawnGate(entry, 'review', await spec.reviewFocus(ticketId));
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

    case 'review-retry': {
      // FLUX-1437: no verdict AND no verdict-shaped comment (the FLUX-1434 incident shape, on the plan
      // gate) — mirrors Temper's/Furnace's `review-retry` handling: one fresh review pass before parking.
      // Shares `reviewNudgeSent` with `review-nudge` above (one nudge budget per review pass total).
      ticket.reviewNudgeSent = true;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await spawnGate(entry, 'review', spec.reviewRetryFocus);
      log.info(`[gate:${spec.gate}] ${ticketId} review completed without a verdict or a verdict-shaped comment — giving it one fresh review pass before parking.`);
      break;
    }

    case 'reimplement': {
      // FLUX-1288: only a genuine one-pass run never loops — a changes-requested verdict from the
      // single pass just sits recorded, flagged for a human. `loop-confirm` (`auto-then-you`) and
      // `loop-auto` (`auto`) both dispatch the revise pass and re-review automatically.
      if (mode === 'one-pass') {
        await stopGateRun(
          spec, ticketId, ws,
          `${spec.gate} gate (one pass): changes requested — flagged for you; Auto→You never auto-revises.`,
          `Plan reviewed — verdict: changes requested. Open the plan to read the feedback and confirm your next step.`,
        );
        break;
      }
      ticket.state = 'reimplementing';
      ticket.attempts = action.attempt;
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      await persistGateAttempts(spec, ticketId, action.attempt, ws);
      await spawnGate(entry, spec.revisePhase, spec.reviseFocus, true);
      break;
    }

    case 'redrive': {
      // No observable session (spawn failed last tick, or the engine restarted) — re-drive the phase.
      // FLUX-1378: stays a cold dispatch, matching furnace-stoker's/temper's untouched redrive — the
      // plan wires resume into the named revise/reimplement dispatches only, not this recovery path.
      delete ticket.currentSessionId;
      delete ticket.sessionStartedAt;
      const isReview = action.phase === 'review';
      const focus = isReview ? await spec.reviewFocus(ticketId) : (ticket.state === 'reimplementing' ? spec.reviseFocus : await spec.reviewFocus(ticketId));
      await spawnGate(entry, isReview ? 'review' : spec.revisePhase, focus);
      break;
    }

    case 'pr-open': {
      // FLUX-1288: `loop-auto` (`auto`) is the only mode that auto-moves on approval. `one-pass` and
      // `loop-confirm` (`auto-then-you`) both stop and flag a human to confirm — `loop-confirm` just got
      // there by looping first, so the human is confirming a plan the automation already iterated on.
      if (mode === 'loop-auto') {
        await spec.onApproved(ticketId);
        await stopGateRun(spec, ticketId, ws);
        break;
      }
      const note = mode === 'one-pass'
        ? `${spec.gate} gate (one pass): approved — flagged for you to confirm; Auto→You never loops.`
        : `${spec.gate} gate: approved after looping — flagged for you to confirm the move to Todo.`;
      await stopGateRun(
        spec, ticketId, ws, note,
        `Plan reviewed — verdict: approved. Confirm to move this ticket to Todo.`,
      );
      break;
    }

    case 'park': {
      await parkGate(spec, ticketId, action.reason, ws);
      break;
    }

    case 'yield': {
      // FLUX-1304 (mirrors Temper's 'yield' handling in temper.ts): the ticket already succeeded/
      // terminalized outside this gate run's control (something else — a finish/merge flow — killed
      // the review session on purpose). Stop tracking quietly instead of leaving the run wedged: with
      // no case here it fell through silently, so `gateRuns` never cleared and the ticket got
      // silently re-evaluated (still yielding, still no-op) on every subsequent tick forever.
      await stopGateRun(spec, ticketId, ws, `${spec.gate} gate yielded — ${action.reason}.`);
      log.info(`[gate:${spec.gate}] ${ticketId} yielded — ${action.reason}.`);
      break;
    }

    // Never produced (rate-limit/context-exhaustion/auth inputs are omitted below) — ignored defensively.
    case 'retry-exhausted':
    case 'cooldown-rate-limited':
    case 'retry-rate-limited':
    case 'halt-auth-expired':
      return;

    // FLUX-1437: exhaustiveness guard — a `TicketAction` variant with no case above now fails
    // `npm run typecheck` instead of silently no-op'ing and wedging the gate run forever (the bug this
    // ticket fixed for `review-retry`: TypeScript does not flag a non-exhaustive switch on its own).
    default: {
      const _exhaustive: never = action;
      throw new Error(`[gate:${spec.gate}] ${ticketId}: unhandled TicketAction ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── Reconcile ────────────────────────────────────────────────────────────────────────────────────

async function reconcileGateTicket(ticketId: string, ws: Workspace): Promise<void> {
  const entry = getEntry(ticketId, ws);
  if (!entry) return;
  if (entry.starting) return; // mid-registration — see `GateRunEntry.starting`
  const { spec, ticket } = entry;

  // FLUX-1263: preserves Temper's exact "yield to an active Furnace batch" precedence (AC #7 there).
  if (isTicketInActiveFurnaceBatch(ticketId)) {
    await stopGateRun(spec, ticketId, ws, `${spec.gate} gate yielded — this ticket is now driven by an active Furnace batch.`);
    log.info(`[gate:${spec.gate}] ${ticketId} now owned by an active Furnace batch — yielding.`);
    return;
  }
  // FLUX-1303: the plan gate only owns Grooming tickets — if a human (board drag, Approve anyway)
  // or an agent moved the ticket out of Grooming while a run was in flight, stop the run instead of
  // driving a re-review against a Todo/In-Progress ticket (whose reviewer would then yank it back
  // to Grooming via its verdict-recording change_status, or park it there via parkStatus).
  const currentTask = ws.tasks[ticketId];
  if (currentTask && currentTask.status !== GROOMING_STATUS) {
    await stopGateRun(spec, ticketId, ws, `${spec.gate} gate stopped — the ticket left ${GROOMING_STATUS} (now ${currentTask.status}) while a run was in flight.`);
    log.info(`[gate:${spec.gate}] ${ticketId} left ${GROOMING_STATUS} mid-run — stopping.`);
    return;
  }
  if (!isActiveTicketState(ticket.state)) return;

  const currentPhase: FurnacePhase | 'grooming' = ticket.state === 'reviewing' ? 'review' : spec.revisePhase;
  // FLUX-1548: narrowed to THIS workspace so a same-id ticket on a different board can never be
  // adopted as this run's session.
  let sess = ticket.currentSessionId ? cliSessionsById.get(ticket.currentSessionId) : undefined;
  if (!sess) sess = pickSessionForPhase(getActiveSessionsForTaskInWorkspace(ticketId, ws.root, getDefaultWorkspace().root), currentPhase);
  if (sess && sess.id !== ticket.currentSessionId) {
    ticket.currentSessionId = sess.id;
    if (!ticket.sessionIds.includes(sess.id)) ticket.sessionIds.push(sess.id);
    if (!ticket.sessionStartedAt) ticket.sessionStartedAt = nowIso();
  }

  const task = ws.tasks[ticketId];
  const verdict = (task?.[spec.verdictField] ?? null) as 'approved' | 'changes-requested' | null;
  const sessionOutcome = findSessionOutcome(task, sess?.id ?? ticket.currentSessionId);
  const action = decideTicketAction({
    ticket,
    ...(sess ? { sessionStatus: sess.status } : {}),
    // Deliberately NOT passing terminalReason — a gate run parks on rate/context limits, same as Temper.
    ...(sessionOutcome ? { sessionOutcome } : {}),
    reviewState: verdict,
    ...(task?.status ? { ticketStatus: task.status } : {}),
    ...(getConfig().requireInputStatus ? { requireInputStatus: getConfig().requireInputStatus } : {}),
    retryCap: DEFAULT_RETRY_CAP,
    reviewVerdictMarkerSeen: lastCommentMatchesVerdictMarker(task?.history, ticket.sessionStartedAt),
  });
  await advanceGateTicket(ticketId, ws, action);
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
  ws: Workspace,
): { ok: false; message: string; reason: 'not-found' | 'wrong-status' | 'already-running' | 'furnace-owned' } | null {
  const task = ws.tasks[ticketId];
  if (!task) return { ok: false, message: `Ticket ${ticketId} not found.`, reason: 'not-found' };
  if (task.status !== GROOMING_STATUS) {
    const verb = kind === 'review' ? 'the plan-review gate only runs' : 'a plan revise only runs';
    return { ok: false, message: `${ticketId} is not in ${GROOMING_STATUS} — ${verb} on a Grooming ticket.`, reason: 'wrong-status' };
  }
  if (isGateRunning(ticketId, ws)) {
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
  // FLUX-1548: capture the ALS-bound workspace once, same idiom as `maybeStartTemper` — pins this run
  // (registry entry, every write, every dispatch) to the board this call targeted.
  const ws = getWorkspace();
  const refusal = planGateStartRefusal(ticketId, 'review', ws);
  if (refusal) return refusal;

  const spec = PLAN_GATE_SPEC;
  const { mode } = opts;
  // Seed the registry SYNCHRONOUSLY (before any await) so a rapid second trigger can't double-start —
  // mirrors `maybeStartTemper`'s exact race-closing idiom. `starting: true` also blocks the
  // background tick from redriving this ticket while the persist + initial dispatch below are still
  // in flight (FLUX-1303 — see `GateRunEntry.starting`).
  const entry: GateRunEntry = { spec, mode, ws, ticket: { ticketId, order: 0, state: 'reviewing', attempts: 0, sessionIds: [] }, starting: true };
  ticketsFor(ws).set(ticketId, entry);
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
      }, ws);
    } catch (e: unknown) {
      log.warn(`[gate:plan] ${ticketId} start persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await runWithWorkspace(ws, () => advanceGateTicket(ticketId, ws, { type: 'review' }));
  } finally {
    entry.starting = false;
  }
  const dispatched = !!getEntry(ticketId, ws)?.ticket.currentSessionId;
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
  const ws = getWorkspace();
  const refusal = planGateStartRefusal(ticketId, 'revise', ws);
  if (refusal) return refusal;
  const task = ws.tasks[ticketId]!;

  const spec = PLAN_GATE_SPEC;
  const gateValue = resolveGateValue(getConfig().gatePolicy, task.gatePolicyOverride, 'plan');
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
  const entry: GateRunEntry = { spec, mode, ws, ticket: { ticketId, order: 0, state: 'reimplementing', attempts: 1, sessionIds: [] }, starting: true };
  ticketsFor(ws).set(ticketId, entry);
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
        ...(notes ? [buildCommentEntry(user, notes, nowIso())] : []),
        buildActivityEntry(
          notes
            ? `Sent for re-grooming by ${user} (notes above) — a grooming session is revising the plan; the gate re-reviews the revision.`
            : `Sent for re-grooming by ${user} — a grooming session is revising the plan against the review feedback; the gate re-reviews the revision.`,
          'Plan Gate',
          nowIso(),
        ),
      ],
      updatedBy: user,
    }, ws);
  } catch (e: unknown) {
    // ABORT — dispatching anyway would run a revise session against a ticket whose durable record
    // (notes comment, verdict, running flag) never landed: the board would show live Approve
    // buttons while an agent rewrites the plan, and the user's notes would exist only inside the
    // ephemeral session focus. The caller keeps the composer content and can simply retry.
    gateRuns.get(wsKey(ws))?.delete(ticketId);
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
    await runWithWorkspace(ws, () => spawnGate(entry, spec.revisePhase, focus, true));
  } finally {
    entry.starting = false;
  }
  const dispatched = !!getEntry(ticketId, ws)?.ticket.currentSessionId;
  return {
    ok: true,
    message: dispatched
      ? `Revise session dispatched for ${ticketId} — the gate re-reviews the revision${mode === 'one-pass' ? ' once, then flags you' : ''}.`
      : `Revise requested for ${ticketId} — waiting for a session to become available.`,
  };
}

/**
 * FLUX-1320: eagerly resolve a just-recorded plan verdict instead of waiting for the next
 * `gateRunnerTick`. Called by the `change_status` handler (mcp-server.ts) the moment it persists an
 * explicit `planReviewState` — the tick path only acts once the review SESSION completes AND the next
 * 5s tick observes it, so `planGateRunning` (the "Revising…" flag) lingered 5-15s after the chat
 * already said approved.
 *
 * Reproduces ONLY the loop-TERMINAL decisions the tick would make, through the same
 * `advanceGateTicket` cases (`pr-open`; `reimplement`'s one-pass stop), so the needsAction messages,
 * the `onApproved` move and the logging stay identical — only WHEN they fire changes. A
 * `changes-requested` verdict under a looping mode is deliberately LEFT TO THE TICK: its next step is
 * the auto-revise dispatch, which must wait for the review session to actually complete (two agents
 * must not write the ticket at once). Every terminal case runs `stopGateRun`, which drops the
 * registry entry — so the tick that fires afterward is a no-op for this ticket (no double-stop, no
 * double-move).
 */
export async function resolvePlanVerdictNow(ticketId: string, verdict: 'approved' | 'changes-requested'): Promise<void> {
  const ws = getWorkspace();
  const entry = getEntry(ticketId, ws);
  if (!entry || entry.starting) return;
  // A verdict concludes a REVIEW pass only — one recorded mid-revise (against the revise focus's
  // explicit "do not call change_status") must not stop the loop before the re-review ran.
  if (entry.ticket.state !== 'reviewing') return;
  // Ownership/status preconditions, mirroring reconcileGateTicket's guards: a ticket owned by an
  // active Furnace batch, or one that already left Grooming, is stopped by the tick with its own
  // dedicated note — leave both to it.
  if (isTicketInActiveFurnaceBatch(ticketId)) return;
  if (ws.tasks[ticketId]?.status !== GROOMING_STATUS) return;

  if (verdict === 'approved') {
    await advanceGateTicket(ticketId, ws, { type: 'pr-open' });
  } else if (entry.mode === 'one-pass') {
    await advanceGateTicket(ticketId, ws, { type: 'reimplement', attempt: entry.ticket.attempts + 1 });
  }
}

// ── Tick orchestration ──────────────────────────────────────────────────────────────────────────

let ticking = false;

/**
 * Advance every actively-running gate ticket, on every live board, by one tick. Never overlaps itself.
 * FLUX-1548: mirrors `temperTick` — each entry's own recorded `ws` drives which board it reconciles
 * against, and every pass runs inside a `runWithWorkspace(ws, …)` binding so ambient `getWorkspace()`
 * reads downstream (`parkTicketOnBoard`, `spec.onApproved`, the self-dispatch header fallback) resolve
 * to that same board.
 */
export async function gateRunnerTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const [, ticketsByRoot] of [...gateRuns.entries()]) {
      for (const [ticketId, entry] of [...ticketsByRoot.entries()]) {
        try {
          await runWithWorkspace(entry.ws, () => reconcileGateTicket(ticketId, entry.ws));
        } catch (e: unknown) {
          log.error(`[gate] tick for ${ticketId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } finally {
    ticking = false;
  }
}

/**
 * Restore the in-memory registry from durable frontmatter after an engine restart (mirrors
 * `rehydrateTemper`). FLUX-1548: scans EVERY live workspace, not just the active one.
 */
export function rehydrateGateRunner(): void {
  const spec = PLAN_GATE_SPEC;
  for (const ws of liveWorkspaces()) {
    for (const id of Object.keys(ws.tasks)) {
      const t = ws.tasks[id];
      if (t?.[spec.runningField] === true && !isGateRunning(id, ws)) {
        const attempts = typeof t[spec.attemptsField] === 'number' ? t[spec.attemptsField] : 0;
        // FLUX-1288: a ticket already mid-loop when this upgrade deploys still carries the legacy boolean
        // frontmatter field — map it to the mode with equivalent semantics rather than losing it.
        const mode: PlanGateMode = PLAN_GATE_MODES.includes(t.planGateMode as PlanGateMode)
          ? (t.planGateMode as PlanGateMode)
          : t.planGateOneShot === true ? 'one-pass' : 'loop-auto';
        // FLUX-1303: restore the phase from any surviving session rather than assuming 'reviewing' —
        // a run rehydrated mid-REVISE as 'reviewing' would redrive a plan-review session concurrently
        // with the still-running grooming revise (two agents writing the same ticket at once).
        const liveRevise = pickSessionForPhase(getActiveSessionsForTaskInWorkspace(id, ws.root, getDefaultWorkspace().root), spec.revisePhase);
        const state = liveRevise ? ('reimplementing' as const) : ('reviewing' as const);
        ticketsFor(ws).set(id, { spec, mode, ws, ticket: { ticketId: id, order: 0, state, attempts, sessionIds: [] } });
        log.info(`[gate:${spec.gate}] rehydrated ${id} (attempts ${attempts}, mode ${mode}, state ${state}, workspace ${ws.root}) — will re-drive on the next tick.`);
      }
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
