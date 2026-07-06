// The Furnace — data model (FLUX-1008 → redesigned as first-class batches in FLUX-1053).
//
// The Furnace is an autonomous ticket runner. Work is organized into first-class **batches**. A batch
// is a named bucket of tickets that burns each one: implement -> review -> (re-implement <= retryCap)
// -> leave the PR open at Ready. It NEVER merges. This file is the pure data model (types + defaults +
// small pure helpers, no I/O); persistence + cache + events live in `furnace-store.ts`, the Stoker
// lives in `furnace-stoker.ts`.
//
// A batch has one of two KINDS (FLUX-1053):
//   sequential — for work where a later ticket needs the prior ticket's progress. All tickets share
//                ONE branch + ONE PR on a single dedicated per-batch worktree, and burn strictly in
//                order so commits accumulate. `burnRate` is irrelevant (forced to 1). Holds exactly
//                1 worktree slot while burning.
//   parallel   — a freeform group of independent tickets; each burns in its OWN worktree and opens
//                its OWN PR. `burnRate` (1–4) = how many of the batch's tickets burn concurrently.
//                Holds up to `burnRate` worktree slots while burning.
//
// There is NO single-active-run invariant anymore: multiple batches burn independently and concurrently,
// bounded only by the global worktree-slot cap (see `FURNACE_WORKTREE_CAP` and the store's slot math).

// ── Batch kind ────────────────────────────────────────────────────────────────
export type BatchKind = 'sequential' | 'parallel';

export const BATCH_KINDS: readonly BatchKind[] = ['sequential', 'parallel'] as const;

// ── Batch status (the whole batch) ────────────────────────────────────────────
//   draft    — being curated, not yet ignited
//   burning  — actively burning its tickets
//   done     — every ticket reached a terminal state; a report exists
//   parked   — halted needing a human (circuit breaker / hard stop with work remaining); report exists
export type BatchStatus = 'draft' | 'burning' | 'done' | 'parked';

export const BATCH_STATUSES: readonly BatchStatus[] = ['draft', 'burning', 'done', 'parked'] as const;

// ── Per-ticket lifecycle state ────────────────────────────────────────────────
//   queued        — loaded, not yet started
//   implementing  — an implementation session is running
//   reviewing     — a review session is running
//   reimplementing— a re-implementation session is running after changes-requested
//   cooling-down  — the last session died from a usage/rate limit (transient); waiting out a cooldown
//                   before auto-retrying (FLUX-1063). NOT terminal, NOT a park — it is waiting, not failed.
//   pr-open       — approved; PR left open at Ready (terminal success; NEVER merged)
//   parked        — needs a human (2 failed reviews, hang, or failure); stays In Progress + Require Input swimlane
//   failed        — unrecoverable error burning this ticket (terminal)
//   skipped       — removed from the burn before it started (terminal)
export type BatchTicketState =
  | 'queued'
  | 'implementing'
  | 'reviewing'
  | 'reimplementing'
  | 'cooling-down'
  | 'pr-open'
  | 'parked'
  | 'failed'
  | 'skipped';

export const BATCH_TICKET_STATES: readonly BatchTicketState[] = [
  'queued', 'implementing', 'reviewing', 'reimplementing', 'cooling-down', 'pr-open', 'parked', 'failed', 'skipped',
] as const;

// Which phase the current session is running (for display + the Stoker's tick logic).
export type FurnacePhase = 'implementation' | 'review';

// ── Ownership + failure taxonomy (FLUX-1066) ────────────────────────────────────

/**
 * Who currently owns a batch ticket. `furnace` (the default — an undefined `owner`) means the Stoker
 * manages it autonomously; `human` means someone took it over (a non-Furnace live session, or an
 * explicit "Take over" action), at which point the Furnace YIELDS — it stops managing the ticket and
 * never reclaims its worktree, and the drawer shows "you're driving this" instead of a park badge.
 */
export type TicketOwner = 'furnace' | 'human';

/**
 * FLUX-1066 failure taxonomy — WHY a ticket stopped and what to do about it. The first two are handled
 * IN-FLIGHT and rarely persist onto a terminal ticket (`transient` → rate-limit cooldown + auto-retry;
 * `recoverable` → fresh session on context exhaustion); the last two are the two park causes, each with
 * its own badge + next action in the drawer:
 *   - `needs-input` — a human decision is required (agent asked a question / left the ticket in Require
 *     Input / review kept requesting changes past retryCap). Legitimately parked → Require Input.
 *   - `hard-fail`   — a bad/broken state (repeated crash, watchdog timeout, spawn failure, a cooldown that
 *     never cleared). Offer Retry / Resume / Take over / Dismiss.
 */
export type FailureClass = 'transient' | 'recoverable' | 'needs-input' | 'hard-fail';

/** Review depth per burn: a single reviewer persona, or a scatter panel. */
export type ReviewDepth = 'single' | 'scatter';

// PR review state as reflected on the batch's PR list (mirrors GitHub-ish states).
export type BatchPrReviewState = 'pending' | 'approved' | 'changes_requested' | 'merged';

export interface BatchTicket {
  /** The loaded ticket. */
  ticketId: string;
  /** Position in the batch (lower burns first). Contiguous but re-orderable. */
  order: number;
  state: BatchTicketState;
  /** Implementation attempts so far (0 before first impl; increments on each re-implement). */
  attempts: number;
  /** Every session spawned for this ticket, in order (impl, review, re-impl, ...). */
  sessionIds: string[];
  /** The in-flight session id, if any (cleared when it reaches a terminal state). */
  currentSessionId?: string;
  /** Which phase `currentSessionId` is running. */
  currentPhase?: FurnacePhase;
  /** Last review verdict read off the ticket (`change_status(reviewState:...)`). */
  lastReviewState?: 'approved' | 'changes-requested' | null;
  /** The open PR URL once the ticket reaches `pr-open`. */
  prUrl?: string;
  /**
   * FLUX-1210: ISO time a `pr-open` ticket was detected as already merged (board `status` flipped to
   * `Done`/`Released` however that happened — `finish_ticket`, a manual `gh pr merge`, or the portal
   * Merge button). Set once by read-time reconcile, never cleared. Purely an annotation — `state` stays
   * `pr-open` (still the terminal success state); this only distinguishes "still awaiting merge" from
   * "already merged" for reporting/display.
   */
  mergedAt?: string;
  /** Human-facing status note — park reason, failure reason, etc. */
  note?: string;
  /** Denormalized ticket title for display (kept fresh on load; may be stale). */
  title?: string;
  /** When this ticket first started burning. */
  startedAt?: string;
  /** When this ticket reached a terminal state. */
  endedAt?: string;
  /** When the current session started (basis for the watchdog timeout). */
  sessionStartedAt?: string;
  /** Consecutive failed attempts to spawn a session for this ticket; parks it past a cap. */
  spawnFailures?: number;
  /**
   * FLUX-1047: how many times this ticket's session has been re-driven with a FRESH session after
   * ending from context-window exhaustion. Bounded by the batch's `exhaustionRetryCap`.
   */
  exhaustionAttempts?: number;
  /**
   * FLUX-1063: rate-limit cooldown state. When a session dies from a usage/rate limit (transient), the
   * ticket enters `cooling-down` and auto-retries on a fixed cadence until the limit clears or a ceiling
   * is hit. These are set on entry and cleared once the ticket makes real forward progress again.
   */
  /** ISO time the CURRENT cooldown episode started — the basis for the `rateLimitMaxWaitMs` ceiling. */
  rateLimitFirstSeenAt?: string;
  /** How many fresh-session retries this cooldown episode has spawned. Does NOT consume `retryCap`. */
  rateLimitAttempts?: number;
  /** ISO time of the next scheduled retry while `cooling-down`. */
  nextRetryAt?: string;
  /** The active state to restore when the cooldown retry fires (implementing / reviewing / reimplementing). */
  preCooldownState?: BatchTicketState;
  /**
   * FLUX-1066: who owns this ticket. Undefined = `furnace` (autonomous). `human` once a non-Furnace
   * session takes it over (auto-detected on reconcile, or an explicit "Take over") — the Furnace then
   * yields: stops managing it, never reclaims its worktree, and the drawer shows "you're driving this".
   */
  owner?: TicketOwner;
  /** FLUX-1066: classification of a park (needs-input vs hard-fail) — drives the drawer badge + next action. */
  failureClass?: FailureClass;
  /** FLUX-1066: the human dismissed the Furnace-raised flag ("I've got this") — drop the badge without re-queuing. */
  flagDismissed?: boolean;
  /**
   * FLUX-1078: a one-shot corrective "review-nudge" already fired for the CURRENT review pass (the
   * review completed with `reviewState` unset but a verdict-shaped comment). Reset to `false` whenever a
   * fresh review session is dispatched, so it caps the nudge at one retry per pass instead of looping
   * forever if the follow-up session also forgets to call `change_status`.
   */
  reviewNudgeSent?: boolean;
}

/** A PR belonging to a batch — one for `sequential`, one-per-ticket for `parallel`. */
export interface BatchPr {
  number?: number;
  url: string;
  branch: string;
  /** The ticket this PR was opened for (parallel); the most-recent ticket to land for sequential. */
  ticketId?: string;
  /**
   * FLUX-1223: every ticket whose commits actually landed on this PR. A `sequential` batch dedups
   * PR entries by branch (all its tickets share one PR) — this accumulates across that dedup so
   * `batch.prs` reflects every ticket, not just whichever one happened to be processed last (what
   * `ticketId` alone captures). For `parallel` batches (one PR per ticket) this is just `[ticketId]`.
   */
  ticketIds?: string[];
  reviewState: BatchPrReviewState;
}

/** Auto-trigger: ignite this batch automatically once `ref` is merged. */
export interface BatchTrigger {
  type: 'batch' | 'pr';
  /** A batch id (type 'batch') or a PR url/number (type 'pr'). */
  ref: string;
}

export interface FurnaceReportLine {
  ticketId: string;
  title?: string;
  prUrl?: string;
  reason?: string;
}

export interface FurnaceReport {
  generatedAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Count of tickets by their final state. */
  counts: Partial<Record<BatchTicketState, number>>;
  /** Tickets that reached `pr-open` and are still awaiting merge, with PR links. */
  prsOpened: FurnaceReportLine[];
  /** FLUX-1210: `pr-open` tickets already merged (`mergedAt` set) — split out of `prsOpened`. */
  merged: FurnaceReportLine[];
  /** Tickets parked for a human, with reasons. */
  parked: FurnaceReportLine[];
  /** Tickets that failed unrecoverably, with reasons. */
  failed: FurnaceReportLine[];
  /** Total tickets that reached a terminal state. */
  processed: number;
  /** True when the consecutive-failure circuit breaker halted the batch. */
  breakerTripped: boolean;
  /** Why the batch ended (all-terminal, manual, breaker, ...). */
  stopReason?: string;
  /** Suggested next actions (e.g. "review 3 PRs", "unblock 1 parked"). */
  nextActions?: string[];
}

export interface FurnaceBatch {
  id: string;
  /** Display name. Mutable while burning (branch is NOT renamed then). */
  title: string;
  kind: BatchKind;
  /**
   * Sequential: the shared branch every ticket stacks onto (one PR). Parallel: a base/prefix; each
   * ticket opens its own branch server-side. Auto-derived on creation; immutable after ignite.
   */
  branch: string;
  status: BatchStatus;
  /** UI palette key for the batch icon (assigned on creation). */
  icon?: string;
  tickets: BatchTicket[];
  /** 1–4. Parallel: concurrent tickets. Sequential: forced to 1. */
  burnRate: number;
  /** Re-implementation cap before parking a ticket. */
  retryCap: number;
  /** FLUX-1047: fresh-session retries for a context-exhausted ticket before parking. */
  exhaustionRetryCap: number;
  /** FLUX-1063: cadence (ms) at which a rate-limited (cooling-down) ticket auto-retries. Default 20m. */
  rateLimitRetryIntervalMs: number;
  /** FLUX-1063: ceiling (ms) a ticket may stay in rate-limit cooldown before failing outright. Default 5h. */
  rateLimitMaxWaitMs: number;
  /** Circuit breaker: park the batch after this many consecutive ticket parks/failures. */
  maxConsecutiveFailures: number;
  /** Running consecutive-failure counter; reset on any ticket success. */
  consecutiveFailures: number;
  /** Reviewer persona for `single` review depth (default senior-dev). */
  reviewPersonaId?: string;
  reviewDepth: ReviewDepth;
  /** Per-session watchdog timeout in ms. */
  sessionTimeoutMs?: number;
  /** Auto-ignite once `trigger.ref` is merged. */
  trigger?: BatchTrigger;
  createdAt: string;
  updatedAt: string;
  ignitedAt?: string;
  completedAt?: string;
  /** A soft stop was requested: stop feeding, let in-flight drain, then finalize. */
  stopRequested?: boolean;
  stopReason?: string;
  createdBy?: string;
  /** PRs opened by this batch (one for sequential, one-per-ticket for parallel). */
  prs: BatchPr[];
  report?: FurnaceReport;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Re-implementation cap fixed by the epic (implement -> review -> reimplement<=2 -> park). */
export const DEFAULT_RETRY_CAP = 2;

/** FLUX-1047: fresh-session retries for a context-exhausted ticket before it parks. */
export const DEFAULT_EXHAUSTION_RETRY_CAP = 2;

/** FLUX-1063: how often a rate-limited (cooling-down) ticket auto-retries — 20 min increments per spec. */
export const DEFAULT_RATE_LIMIT_RETRY_INTERVAL_MS = 20 * 60 * 1000;

/** FLUX-1063: how long a ticket may stay in rate-limit cooldown before failing outright — 5 hours. */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 60 * 1000;

/** Per-session watchdog default (45 min) — generous headroom over a normal burn, safety net for a hang. */
export const DEFAULT_SESSION_TIMEOUT_MS = 45 * 60 * 1000;

/** Circuit breaker default — 3 consecutive parks/failures assume a broken environment. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** Default reviewer persona for `single` review depth. */
export const DEFAULT_REVIEW_PERSONA = 'senior-dev';

/** Hard cap on burn rate (also the worktree-slot cap; kept in sync with DEFAULT_MAX_TASK_WORKTREES). */
export const MAX_BURN_RATE = 4;


/** Small palette of icon keys assigned round-robin to new batches (mirrored in the portal). */
export const BATCH_ICON_PALETTE = ['bolt', 'beaker', 'layers', 'flame', 'zap', 'filter'] as const;

// ── Branch derivation ──────────────────────────────────────────────────────────

/** Slugify a title into a git-ref-safe fragment. */
export function slugifyBranchFragment(title: string): string {
  return (title || 'batch')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'batch';
}

/** The stable shared/base branch name for a batch (git-ref safe). */
export function batchBranchName(id: string, title: string): string {
  return `flux/furnace-${id.slice(0, 8)}-${slugifyBranchFragment(title)}`;
}

// ── Constructors ────────────────────────────────────────────────────────────────

/** Return a new ticket in the initial `queued` state. */
export function newBatchTicket(ticketId: string, order: number, title?: string): BatchTicket {
  const t: BatchTicket = { ticketId, order, state: 'queued', attempts: 0, sessionIds: [] };
  if (title !== undefined) t.title = title;
  return t;
}

/**
 * Re-number tickets to contiguous 0..n-1 following their current `order` (stable for ties by array
 * position). Returns a new array; does not mutate input.
 */
export function normalizeTicketOrder(tickets: BatchTicket[]): BatchTicket[] {
  return [...tickets]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.order - b.e.order) || (a.i - b.i))
    .map(({ e }, idx) => (e.order === idx ? e : { ...e, order: idx }));
}

/**
 * Build a fresh batch with defaults filled in. Pure except for the caller-supplied `now`/`id` (kept as
 * params so the store owns id/clock and this stays unit-testable).
 */
export function newFurnaceBatch(input: {
  id: string;
  now: string;
  title: string;
  kind?: BatchKind;
  branch?: string;
  tickets?: BatchTicket[];
  burnRate?: number;
  retryCap?: number;
  exhaustionRetryCap?: number;
  rateLimitRetryIntervalMs?: number;
  rateLimitMaxWaitMs?: number;
  maxConsecutiveFailures?: number;
  reviewDepth?: ReviewDepth;
  reviewPersonaId?: string;
  sessionTimeoutMs?: number;
  trigger?: BatchTrigger;
  icon?: string;
  createdBy?: string;
}): FurnaceBatch {
  const kind: BatchKind = input.kind ?? 'parallel';
  const requestedRate = input.burnRate ?? 1;
  const burnRate = kind === 'sequential' ? 1 : clampBurnRate(requestedRate);
  const batch: FurnaceBatch = {
    id: input.id,
    title: input.title,
    kind,
    branch: input.branch ?? batchBranchName(input.id, input.title),
    status: 'draft',
    tickets: normalizeTicketOrder(input.tickets ?? []),
    burnRate,
    retryCap: input.retryCap ?? DEFAULT_RETRY_CAP,
    exhaustionRetryCap: input.exhaustionRetryCap ?? DEFAULT_EXHAUSTION_RETRY_CAP,
    rateLimitRetryIntervalMs: input.rateLimitRetryIntervalMs ?? DEFAULT_RATE_LIMIT_RETRY_INTERVAL_MS,
    rateLimitMaxWaitMs: input.rateLimitMaxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
    maxConsecutiveFailures: input.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
    consecutiveFailures: 0,
    reviewDepth: input.reviewDepth ?? 'single',
    reviewPersonaId: input.reviewPersonaId ?? DEFAULT_REVIEW_PERSONA,
    sessionTimeoutMs: input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    createdAt: input.now,
    updatedAt: input.now,
    prs: [],
  };
  if (input.trigger !== undefined) batch.trigger = input.trigger;
  if (input.icon !== undefined) batch.icon = input.icon;
  if (input.createdBy !== undefined) batch.createdBy = input.createdBy;
  return batch;
}

/** Clamp a requested burn rate to [1, MAX_BURN_RATE]. */
export function clampBurnRate(rate: number | undefined): number {
  const r = Math.floor(rate ?? 1);
  if (!Number.isFinite(r) || r < 1) return 1;
  return Math.min(r, MAX_BURN_RATE);
}

// ── Pure ticket-state helpers ──────────────────────────────────────────────────

/** A ticket that is currently burning (an in-flight session). */
export function isActiveTicketState(s: BatchTicketState): boolean {
  return s === 'implementing' || s === 'reviewing' || s === 'reimplementing';
}

/** A ticket that has reached a final state and will not change again. */
export function isTerminalTicketState(s: BatchTicketState): boolean {
  return s === 'pr-open' || s === 'parked' || s === 'failed' || s === 'skipped';
}

/**
 * FLUX-1066: a ticket a human has taken over. The Furnace yields on these — the Stoker skips them when
 * reconciling / feeding coal / running the watchdog, and never counts them against the batch as failures.
 */
export function isHumanOwned(t: BatchTicket): boolean {
  return t.owner === 'human';
}

/**
 * FLUX-1066: a ticket is "settled" for the Furnace when it has reached a terminal state OR a human has
 * taken it over — either way the Stoker has nothing left to do with it, so the batch can finalize.
 */
export function isSettledTicket(t: BatchTicket): boolean {
  return isTerminalTicketState(t.state) || isHumanOwned(t);
}

/** A batch that is ignited and not yet finished. */
export function isBatchActive(status: BatchStatus): boolean {
  return status === 'burning';
}

/**
 * FLUX-1142: reject a `batch`-type trigger that would point a batch at itself, or form a direct
 * A→B→A cycle (the candidate `ref` already triggers off this batch) — either would deadlock, since
 * neither batch's trigger could ever be satisfied. A `pr`-type trigger can't cycle (its `ref` is a
 * PR url/number, not a batch id), so it always passes.
 *
 * FLUX-1181: also reject arming (a non-null) trigger on a batch that isn't currently `draft` —
 * `checkTriggers` in the Stoker only evaluates `draft` batches, and `resume` takes a parked/done
 * batch straight to `burning` without passing back through `draft`, so a trigger armed on a
 * non-draft batch would be accepted but silently never fire. Clearing a trigger (`null`) is always
 * allowed, including on a non-draft batch, so a stale/un-firable one can still be removed.
 *
 * Returns an error message, or `null` if valid.
 */
export function validateBatchTrigger(
  batchId: string,
  trigger: BatchTrigger | null | undefined,
  allBatches: readonly FurnaceBatch[],
): string | null {
  if (!trigger) return null;
  const self = allBatches.find((b) => b.id === batchId);
  if (self && self.status !== 'draft') {
    return 'A trigger can only be armed while the batch is a draft — it is never evaluated once ignited, parked, or done.';
  }
  if (trigger.type !== 'batch') return null;
  if (trigger.ref === batchId) return 'A batch cannot trigger off itself.';
  const referenced = allBatches.find((b) => b.id === trigger.ref);
  if (referenced?.trigger?.type === 'batch' && referenced.trigger.ref === batchId) {
    return `"${referenced.title}" already triggers after this batch — that would create a cycle.`;
  }
  return null;
}

/** A batch that has finished (a report exists / will exist). */
export function isBatchTerminal(status: BatchStatus): boolean {
  return status === 'done' || status === 'parked';
}

/** The count of tickets currently burning (in-flight sessions) in a batch. */
export function activeTicketCount(batch: FurnaceBatch): number {
  return batch.tickets.filter((t) => isActiveTicketState(t.state)).length;
}

/** The count of tickets that have reached a terminal state. */
export function terminalTicketCount(batch: FurnaceBatch): number {
  return batch.tickets.filter((t) => isTerminalTicketState(t.state)).length;
}

/** The next queued ticket in burn order, or undefined if none remain. Skips a human-owned ticket (FLUX-1066). */
export function nextQueuedTicket(batch: FurnaceBatch): BatchTicket | undefined {
  return normalizeTicketOrder(batch.tickets).find((t) => t.state === 'queued' && !isHumanOwned(t));
}

/** True when every ticket has reached a terminal state. */
export function allTicketsTerminal(batch: FurnaceBatch): boolean {
  return batch.tickets.length > 0 && batch.tickets.every((t) => isTerminalTicketState(t.state));
}

/**
 * FLUX-1066: true when every ticket is settled (terminal OR human-owned). The Stoker finalizes on this
 * rather than {@link allTicketsTerminal} so a taken-over ticket (which the Furnace no longer drives)
 * cannot wedge the batch burning forever.
 */
export function allTicketsSettled(batch: FurnaceBatch): boolean {
  return batch.tickets.length > 0 && batch.tickets.every((t) => isSettledTicket(t));
}

// ── Sequential-batch helpers (shared branch / one PR) ───────────────────────────

/** The anchor of a sequential batch — its lowest-`order` ticket. Creates the shared branch + worktree. */
export function sequentialAnchor(batch: FurnaceBatch): BatchTicket | undefined {
  if (batch.kind !== 'sequential') return undefined;
  return normalizeTicketOrder(batch.tickets)[0];
}

/**
 * True when `ticket` is a sequential follower — a non-anchor member of a sequential batch. A follower
 * reuses the anchor's shared worktree (resolved server-side by the shared branch) rather than creating
 * its own, so its dispatch must skip server-side isolation.
 */
export function isSequentialFollower(batch: FurnaceBatch, ticket: BatchTicket): boolean {
  if (batch.kind !== 'sequential') return false;
  const anchor = sequentialAnchor(batch);
  return anchor !== undefined && anchor.ticketId !== ticket.ticketId;
}

// ── Slot math ──────────────────────────────────────────────────────────────────

/**
 * Worktree slots a batch is holding RIGHT NOW.
 *   not burning        → 0
 *   sequential burning → 1 (one shared worktree for the whole batch)
 *   parallel burning   → one per ticket that still holds a worktree
 *
 * FLUX-1063: a `cooling-down` ticket is not "active" (no live session), but its git worktree is NOT
 * torn down during the rate-limit cooldown — the retry reuses it. So it still HOLDS a slot: counting
 * only active tickets here would free the slot in the global accounting while the worktree persists on
 * disk, letting another batch claim it and over-commit past the worktree cap when the retry reactivates.
 */
export function batchSlotUsage(batch: FurnaceBatch): number {
  if (batch.status !== 'burning') return 0;
  if (batch.kind === 'sequential') return 1;
  return batch.tickets.filter((t) => isActiveTicketState(t.state) || t.state === 'cooling-down').length;
}

/**
 * FLUX-1066/1067: the ticket ids whose worktrees a burning batch reserves RIGHT NOW — the identity-level
 * companion to {@link batchSlotUsage} (its length equals `batchSlotUsage`). It lets the global slot
 * accounting tell a Furnace-BACKED observed worktree apart from an INDEPENDENT one so it can add
 * reservations not yet on disk to the observed pool without double-counting the ones already backed.
 *   not burning        → none
 *   sequential burning → the anchor's ticket (the one shared worktree is created under the anchor's id)
 *   parallel burning   → each active/cooling ticket (each holds its own worktree; cooling-down persists it)
 */
export function furnaceReservedTicketIds(batch: FurnaceBatch): string[] {
  if (batch.status !== 'burning') return [];
  if (batch.kind === 'sequential') {
    const anchor = sequentialAnchor(batch);
    return anchor ? [anchor.ticketId] : [];
  }
  return batch.tickets
    .filter((t) => isActiveTicketState(t.state) || t.state === 'cooling-down')
    .map((t) => t.ticketId);
}

/**
 * FLUX-1067 (revised, M3): worktree slots in use, computed so it can neither UNDERCOUNT (→ ignite
 * over-spawns past the real worktree pool) NOR double-count a reservation already backed by an observed
 * worktree. The two views are DISJOINT sets, not nested, so the old `max(reservations, observed)`
 * undercounted whenever an independent/manual worktree coexisted with a freshly-claimed Furnace reservation
 * whose worktree wasn't on disk yet (true total = the SUM of the parts, but `max` reported only the larger).
 * Instead:
 *   independent observed = observed worktrees NOT backing a current Furnace reservation
 *   total                = independent observed + reservations
 * A reservation whose worktree isn't on disk yet is unbacked → still counted (via `reservations`); one
 * already on disk is backed → counted once. `observed.count` is the raw worktree count and may exceed
 * `observed.ticketIds` when a path doesn't resolve to a ticket — those are always independent.
 */
export function computeSlotsInUse(
  reservedTicketIds: readonly string[],
  observed: { count: number; ticketIds: readonly string[] },
): number {
  const observedSet = new Set(observed.ticketIds);
  const backed = new Set(reservedTicketIds.filter((id) => observedSet.has(id))).size;
  const independentObserved = Math.max(0, observed.count - backed);
  return independentObserved + reservedTicketIds.length;
}

/**
 * The max slots a batch may consume while burning — its reservation ceiling.
 *   sequential → 1
 *   parallel   → its (clamped) burn rate
 */
export function batchSlotCeiling(batch: FurnaceBatch): number {
  if (batch.kind === 'sequential') return 1;
  return clampBurnRate(batch.burnRate);
}

/**
 * How many tickets of a batch may burn at once.
 *   sequential → 1 (ordered stacking on the shared branch)
 *   parallel   → clamped burn rate
 */
export function effectiveConcurrency(batch: FurnaceBatch): number {
  if (batch.kind === 'sequential') return 1;
  return clampBurnRate(batch.burnRate);
}

// ── Report ───────────────────────────────────────────────────────────────────

/**
 * Assemble the burn report from a batch's final state. Pure — `now` is passed in so it stays
 * unit-testable and the store owns the clock.
 */
export function assembleBurnReport(batch: FurnaceBatch, now: string): FurnaceReport {
  const counts: Partial<Record<BatchTicketState, number>> = {};
  for (const t of batch.tickets) counts[t.state] = (counts[t.state] || 0) + 1;

  const line = (t: BatchTicket, withReason: boolean): FurnaceReportLine => {
    const l: FurnaceReportLine = { ticketId: t.ticketId };
    if (t.title !== undefined) l.title = t.title;
    if (t.prUrl !== undefined) l.prUrl = t.prUrl;
    if (withReason) l.reason = t.note || t.state;
    return l;
  };

  const prOpenTickets = batch.tickets.filter((t) => t.state === 'pr-open');
  const prsOpened = prOpenTickets.filter((t) => !t.mergedAt).map((t) => line(t, false));
  const merged = prOpenTickets.filter((t) => t.mergedAt).map((t) => line(t, false));
  const parked = batch.tickets.filter((t) => t.state === 'parked').map((t) => line(t, true));
  const failed = batch.tickets.filter((t) => t.state === 'failed').map((t) => line(t, true));
  const processed = batch.tickets.filter((t) => isTerminalTicketState(t.state)).length;

  const breakerTripped = (batch.consecutiveFailures || 0) >= batch.maxConsecutiveFailures;

  const nextActions: string[] = [];
  if (prsOpened.length) nextActions.push(`Review ${prsOpened.length} open PR(s) and merge the good ones.`);
  if (parked.length) nextActions.push(`Unblock ${parked.length} parked ticket(s) flagged with the Require Input swimlane.`);
  if (failed.length) nextActions.push(`Investigate ${failed.length} failed ticket(s).`);
  if (breakerTripped) nextActions.push('The circuit breaker tripped — check the environment before re-igniting.');

  const report: FurnaceReport = {
    generatedAt: now,
    endedAt: now,
    counts,
    prsOpened,
    merged,
    parked,
    failed,
    processed,
    breakerTripped,
  };
  if (batch.ignitedAt) {
    report.startedAt = batch.ignitedAt;
    const startMs = Date.parse(batch.ignitedAt);
    const endMs = Date.parse(now);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) report.durationMs = endMs - startMs;
  }
  if (batch.stopReason) report.stopReason = batch.stopReason;
  if (nextActions.length) report.nextActions = nextActions;
  return report;
}
