// Portal-side mirror of the engine Furnace batch model (engine/src/models/furnace.ts). The portal
// can't import engine code, so these types are kept in sync by hand.

export type BatchKind = 'sequential' | 'parallel';

export type BatchStatus = 'draft' | 'burning' | 'done' | 'parked';

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

export type FurnacePhase = 'implementation' | 'review';
export type ReviewDepth = 'single' | 'scatter';
export type BatchPrReviewState = 'pending' | 'approved' | 'changes_requested' | 'merged';

/** FLUX-1066: who owns a ticket — `furnace` (autonomous, the default) or `human` (taken over). */
export type TicketOwner = 'furnace' | 'human';

/** FLUX-1066: why a ticket parked — drives the drawer badge + next action. */
export type FailureClass = 'transient' | 'recoverable' | 'needs-input' | 'hard-fail';

/** Hard cap on burn rate (= the worktree-slot cap). Mirrors engine MAX_BURN_RATE. */
export const MAX_BURN_RATE = 4;

/** Icon palette keys assigned round-robin to new batches (mirrors engine BATCH_ICON_PALETTE). */
export const BATCH_ICON_PALETTE = ['bolt', 'beaker', 'layers', 'flame', 'zap', 'filter'] as const;

export interface BatchTicket {
  ticketId: string;
  order: number;
  state: BatchTicketState;
  attempts: number;
  sessionIds: string[];
  currentSessionId?: string;
  currentPhase?: FurnacePhase;
  lastReviewState?: 'approved' | 'changes-requested' | null;
  prUrl?: string;
  // FLUX-1210: set once a `pr-open` ticket is detected as already merged (board status -> Done/Released).
  mergedAt?: string;
  note?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  sessionStartedAt?: string;
  spawnFailures?: number;
  exhaustionAttempts?: number;
  // FLUX-1063: rate-limit cooldown bookkeeping (present while `state === 'cooling-down'`).
  rateLimitFirstSeenAt?: string;
  rateLimitAttempts?: number;
  nextRetryAt?: string;
  preCooldownState?: BatchTicketState;
  // FLUX-1066: ownership handoff + failure taxonomy.
  owner?: TicketOwner;
  failureClass?: FailureClass;
  flagDismissed?: boolean;
}

export interface BatchPr {
  number?: number;
  url: string;
  branch: string;
  ticketId?: string;
  /** FLUX-1223: every ticket whose commits landed on this PR (a sequential batch's shared PR has >1). */
  ticketIds?: string[];
  reviewState: BatchPrReviewState;
}

export interface BatchTrigger {
  type: 'batch' | 'pr';
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
  counts: Partial<Record<BatchTicketState, number>>;
  prsOpened: FurnaceReportLine[];
  // FLUX-1210: `pr-open` tickets already merged — split out of `prsOpened`.
  merged: FurnaceReportLine[];
  parked: FurnaceReportLine[];
  failed: FurnaceReportLine[];
  processed: number;
  breakerTripped: boolean;
  stopReason?: string;
  nextActions?: string[];
}

export interface FurnaceBatch {
  id: string;
  title: string;
  kind: BatchKind;
  branch: string;
  status: BatchStatus;
  icon?: string;
  tickets: BatchTicket[];
  burnRate: number;
  retryCap: number;
  exhaustionRetryCap: number;
  rateLimitRetryIntervalMs: number;
  rateLimitMaxWaitMs: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  reviewPersonaId?: string;
  reviewDepth: ReviewDepth;
  sessionTimeoutMs?: number;
  trigger?: BatchTrigger;
  createdAt: string;
  updatedAt: string;
  ignitedAt?: string;
  completedAt?: string;
  stopRequested?: boolean;
  stopReason?: string;
  createdBy?: string;
  prs: BatchPr[];
  report?: FurnaceReport;
  /**
   * FLUX-1270: display-only provenance — set when this batch was spun off from another (non-terminal)
   * batch to pull a same-branch-dependent follow-up + its parent out into their own standalone
   * sequential batch (reusing the parent's branch). Rendered as a "spun off from" subtitle; no
   * lifecycle control reads it.
   */
  spawnedFrom?: { batchId: string; ticketId: string };
}

/** Live worktree-slot usage returned by GET /api/furnace/slots. */
export interface SlotInfo {
  used: number;
  free: number;
  max: number;
}

/** A ticket holding a worktree slot on a `no_slots` refusal, with why reclaim didn't free it (FLUX-1157). */
export interface FurnaceSlotHolder {
  ticketId: string;
  reason: string;
}

/** A ticket the builder deliberately excluded, with why. */
export interface ExcludedTicket {
  ticketId: string;
  title?: string;
  reason: string;
}

// dnd-kit drop-target ids + refresh event shared by Board (drag source side) and FurnaceDrawer.
export const FURNACE_REFRESH_EVENT = 'furnace-refresh';
export const FURNACE_NEW_DROP_ID = 'furnace:new';
export const furnaceBatchDropId = (id: string) => `furnace:batch:${id}`;
