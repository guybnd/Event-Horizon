// The Furnace — batch model + decision core + slot math (FLUX-1053).
//
// Focused unit tests for the redesigned batch architecture. The run/magazine/group tests were removed
// with that architecture; this covers the pure, high-value surfaces: the per-ticket decision core, the
// two batch kinds, worktree-slot math, and the burn report.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  newFurnaceBatch,
  newBatchTicket,
  clampBurnRate,
  effectiveConcurrency,
  batchSlotCeiling,
  batchSlotUsage,
  sequentialAnchor,
  isSequentialFollower,
  nextQueuedTicket,
  allTicketsTerminal,
  allTicketsSettled,
  isHumanOwned,
  isSettledTicket,
  assembleBurnReport,
  batchBranchName,
  furnaceReservedTicketIds,
  computeSlotsInUse,
  validateBatchTrigger,
  batchBelongsToWorkspaceRoot,
  MAX_BURN_RATE,
  type FurnaceBatch,
  type BatchTicket,
} from './models/furnace.js';
import {
  decideTicketAction,
  isSessionTimedOut,
  breakerTripped,
  isTriggerSatisfied,
  isHumanTakeover,
  decideReconcile,
  retryRejectionReason,
  countsTowardBreaker,
  pickPrReview,
  mirrorReviewVerdictToPr,
  lastCommentMatchesVerdictMarker,
  findSessionOutcome,
  upsertBatchPr,
  stokerTick,
} from './furnace-stoker.js';
import { setWorkspaceRoot } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { createTask } from './task-store.js';
import {
  createFurnaceBatch,
  mutateFurnaceBatch,
  getFurnaceBatch,
  ensureFurnaceLoaded,
  __resetFurnaceStoreForTests,
} from './furnace-store.js';
import { cliSessionsById, cliSessionsByTaskId, registerSession } from './session-store.js';
import * as sessionStoreModule from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

// FLUX-1057/FLUX-1049: mock the real GitHub call so verdict-gating tests never shell out to `gh`.
const postPrReview = vi.fn(async () => 'approved' as const);
vi.mock('./branch-manager.js', () => ({
  postPrReview: (...args: unknown[]) => postPrReview(...(args as [])),
  mergePullRequest: vi.fn(),
}));

function mkBatch(over: Partial<FurnaceBatch> = {}): FurnaceBatch {
  const b = newFurnaceBatch({ id: 'batch-1234abcd', now: '2026-07-02T00:00:00.000Z', title: 'Test batch' });
  return { ...b, ...over };
}
function mkTicket(over: Partial<BatchTicket> = {}): BatchTicket {
  return { ...newBatchTicket('FLUX-1', 0), ...over };
}

describe('batch model defaults', () => {
  it('parallel is the default kind and clamps burn rate', () => {
    const b = newFurnaceBatch({ id: 'aaaaaaaa-1', now: 'now', title: 'X', burnRate: 99 });
    expect(b.kind).toBe('parallel');
    expect(b.burnRate).toBe(MAX_BURN_RATE);
    expect(b.status).toBe('draft');
  });
  it('sequential forces burn rate 1', () => {
    const b = newFurnaceBatch({ id: 'aaaaaaaa-2', now: 'now', title: 'X', kind: 'sequential', burnRate: 4 });
    expect(b.burnRate).toBe(1);
  });
  it('derives a git-ref-safe branch from the title', () => {
    expect(batchBranchName('abcd1234ef', 'Auth Refactor!')).toBe('flux/furnace-abcd1234-auth-refactor');
  });
  it('clampBurnRate floors at 1 and caps at MAX', () => {
    expect(clampBurnRate(0)).toBe(1);
    expect(clampBurnRate(-5)).toBe(1);
    expect(clampBurnRate(2)).toBe(2);
    expect(clampBurnRate(100)).toBe(MAX_BURN_RATE);
  });
  // FLUX-1270: branch adoption (an explicit `branch` override) + `spawnedFrom` provenance — the two
  // additions that let a same-branch-dependent follow-up + its parent be pulled into a standalone
  // sequential batch reusing the parent's still-open-PR branch.
  it('accepts an explicit branch override instead of deriving one (branch adoption)', () => {
    const b = newFurnaceBatch({ id: 'aaaaaaaa-3', now: 'now', title: 'Spun off', kind: 'sequential', branch: 'flux/FLUX-861-parent-branch' });
    expect(b.branch).toBe('flux/FLUX-861-parent-branch');
  });
  it('stamps spawnedFrom when provided, and omits it otherwise', () => {
    const spun = newFurnaceBatch({ id: 'aaaaaaaa-4', now: 'now', title: 'Spun off', spawnedFrom: { batchId: 'origin-batch', ticketId: 'FLUX-861' } });
    expect(spun.spawnedFrom).toEqual({ batchId: 'origin-batch', ticketId: 'FLUX-861' });
    const plain = newFurnaceBatch({ id: 'aaaaaaaa-5', now: 'now', title: 'Plain' });
    expect(plain.spawnedFrom).toBeUndefined();
  });
});

describe('slot math', () => {
  it('sequential burning batch holds exactly one slot; ceiling is 1', () => {
    const b = mkBatch({ kind: 'sequential', status: 'burning', tickets: [mkTicket({ state: 'implementing' })] });
    expect(batchSlotUsage(b)).toBe(1);
    expect(batchSlotCeiling(b)).toBe(1);
    expect(effectiveConcurrency(b)).toBe(1);
  });
  it('parallel burning batch holds one slot per active ticket; ceiling is burn rate', () => {
    const b = mkBatch({
      kind: 'parallel',
      burnRate: 3,
      status: 'burning',
      tickets: [
        mkTicket({ ticketId: 'A', state: 'implementing' }),
        mkTicket({ ticketId: 'B', state: 'reviewing' }),
        mkTicket({ ticketId: 'C', state: 'queued' }),
      ],
    });
    expect(batchSlotUsage(b)).toBe(2);
    expect(batchSlotCeiling(b)).toBe(3);
    expect(effectiveConcurrency(b)).toBe(3);
  });
  it('a non-burning batch holds zero slots', () => {
    const b = mkBatch({ kind: 'parallel', status: 'draft', tickets: [mkTicket({ state: 'implementing' })] });
    expect(batchSlotUsage(b)).toBe(0);
  });
  it('a cooling-down ticket still holds its worktree slot (FLUX-1063 — worktree persists during cooldown)', () => {
    const b = mkBatch({
      kind: 'parallel',
      burnRate: 3,
      status: 'burning',
      tickets: [
        mkTicket({ ticketId: 'A', state: 'implementing' }),
        mkTicket({ ticketId: 'B', state: 'cooling-down' }),
        mkTicket({ ticketId: 'C', state: 'queued' }),
      ],
    });
    // Both the active AND the cooling-down ticket hold a slot; the queued one does not.
    expect(batchSlotUsage(b)).toBe(2);
  });
});

describe('batchBelongsToWorkspaceRoot (FLUX-1513/1527)', () => {
  it('a tagged batch matches only its own workspaceRoot, not a sibling or the default', () => {
    const b = mkBatch({ workspaceRoot: '/ws-a' });
    expect(batchBelongsToWorkspaceRoot(b, '/ws-a', '/default')).toBe(true);
    expect(batchBelongsToWorkspaceRoot(b, '/ws-b', '/default')).toBe(false);
    expect(batchBelongsToWorkspaceRoot(b, '/default', '/default')).toBe(false);
  });
  it('an untagged legacy batch falls back to the default workspace root, not a sibling pass', () => {
    const b = mkBatch(); // no workspaceRoot override — untagged, like a batch created before FLUX-1513
    expect(batchBelongsToWorkspaceRoot(b, '/default', '/default')).toBe(true);
    expect(batchBelongsToWorkspaceRoot(b, '/ws-a', '/default')).toBe(false);
  });
  it('null-root edge: a null default workspace root still resolves an untagged legacy batch to the default pass', () => {
    const b = mkBatch(); // no workspaceRoot override — untagged, like a batch created before FLUX-1513
    expect(batchBelongsToWorkspaceRoot(b, null, null)).toBe(true);
    expect(batchBelongsToWorkspaceRoot(b, '/ws-a', null)).toBe(false);
  });
});

describe('sequential anchor / follower', () => {
  const b = mkBatch({
    kind: 'sequential',
    tickets: [mkTicket({ ticketId: 'A', order: 0 }), mkTicket({ ticketId: 'B', order: 1 }), mkTicket({ ticketId: 'C', order: 2 })],
  });
  it('anchor is the lowest-order ticket', () => {
    expect(sequentialAnchor(b)?.ticketId).toBe('A');
  });
  it('followers are every non-anchor member', () => {
    expect(isSequentialFollower(b, b.tickets[0]!)).toBe(false);
    expect(isSequentialFollower(b, b.tickets[1]!)).toBe(true);
  });
  it('parallel batches have no anchor/follower concept', () => {
    const p = mkBatch({ kind: 'parallel', tickets: [mkTicket({ ticketId: 'A' })] });
    expect(sequentialAnchor(p)).toBeUndefined();
    expect(isSequentialFollower(p, p.tickets[0]!)).toBe(false);
  });
});

describe('decideTicketAction (pure decision core)', () => {
  it('waits while the session is running', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'running', retryCap: 2 });
    expect(a.type).toBe('wait');
  });
  // FLUX-1390: a 'scheduled' session is honoring a ScheduleWakeup call — asleep, not idle — and
  // must never be treated as a false "no verdict" park the way 'waiting-input' is (below).
  it('waits (never parks) while the session is scheduled — an honored ScheduleWakeup sleep', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'scheduled', retryCap: 2 });
    expect(a.type).toBe('wait');
  });
  it('re-drives when there is no observable session', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), retryCap: 2 });
    expect(a).toEqual({ type: 'redrive', phase: 'review' });
  });
  it('implementation complete → review', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'completed', retryCap: 2 });
    expect(a.type).toBe('review');
  });
  it('parks when implementation ends in Require Input', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'completed', ticketStatus: 'Require Input', requireInputStatus: 'Require Input', retryCap: 2 });
    expect(a.type).toBe('park');
  });
  it('approved review → pr-open with the PR url', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'completed', reviewState: 'approved', prUrl: 'http://pr/1', retryCap: 2 });
    expect(a).toEqual({ type: 'pr-open', prUrl: 'http://pr/1' });
  });
  it('changes-requested re-implements under the cap, parks past it', () => {
    const under = decideTicketAction({ ticket: mkTicket({ state: 'reviewing', attempts: 1 }), sessionStatus: 'completed', reviewState: 'changes-requested', retryCap: 2 });
    expect(under).toEqual({ type: 'reimplement', attempt: 2 });
    const over = decideTicketAction({ ticket: mkTicket({ state: 'reviewing', attempts: 2 }), sessionStatus: 'completed', reviewState: 'changes-requested', retryCap: 2 });
    expect(over.type).toBe('park');
  });
  // FLUX-1437: no verdict AND no verdict-marker comment gets ONE fresh review-retry pass before
  // parking — the FLUX-1434 incident shape (review completed but ended on a dead wait promise
  // instead of calling change_status). Shares the reviewNudgeSent budget with the marker-nudge above.
  it('review with no verdict gets ONE review-retry, not an immediate park', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'completed', reviewState: null, retryCap: 2 });
    expect(a).toEqual({ type: 'review-retry' });
  });
  it('does not review-retry twice — a ticket that already used its nudge budget parks', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing', reviewNudgeSent: true }), sessionStatus: 'completed', reviewState: null, retryCap: 2 });
    expect(a.type).toBe('park');
  });

  // FLUX-1078: a review that ends with reviewState unset but a verdict-shaped last comment gets one
  // corrective nudge instead of an immediate park — capped so it can't loop forever.
  it('review with no verdict but a verdict-marker comment gets ONE nudge, not a park', () => {
    const a = decideTicketAction({
      ticket: mkTicket({ state: 'reviewing' }),
      sessionStatus: 'completed',
      reviewState: null,
      reviewVerdictMarkerSeen: true,
      retryCap: 2,
    });
    expect(a).toEqual({ type: 'review-nudge' });
  });
  it('does not nudge twice — a ticket that already used its nudge falls back to park', () => {
    const a = decideTicketAction({
      ticket: mkTicket({ state: 'reviewing', reviewNudgeSent: true }),
      sessionStatus: 'completed',
      reviewState: null,
      reviewVerdictMarkerSeen: true,
      retryCap: 2,
    });
    expect(a.type).toBe('park');
  });
  it('waiting-input parks (unattended run cannot answer)', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'waiting-input', retryCap: 2 });
    expect(a.type).toBe('park');
  });
  it('context exhaustion retries under the exhaustion cap, then parks', () => {
    const retry = decideTicketAction({ ticket: mkTicket({ state: 'implementing', exhaustionAttempts: 0 }), sessionStatus: 'failed', terminalReason: 'context-exhausted', retryCap: 2, exhaustionRetryCap: 2 });
    expect(retry).toEqual({ type: 'retry-exhausted', phase: 'implementation', attempt: 1 });
    const park = decideTicketAction({ ticket: mkTicket({ state: 'implementing', exhaustionAttempts: 2 }), sessionStatus: 'failed', terminalReason: 'context-exhausted', retryCap: 2, exhaustionRetryCap: 2 });
    expect(park.type).toBe('park');
  });

  // FLUX-1063: a transient rate limit cools the ticket down (not a park) and auto-retries on a cadence.
  it('a rate-limited failed session enters cooldown (not a park), sparing retryCap + the breaker', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'failed', terminalReason: 'rate-limited', retryCap: 2 });
    expect(a).toEqual({ type: 'cooldown-rate-limited' });
  });

  // FLUX-1397: an expired/invalid credential is a whole-batch problem — halt immediately (one
  // re-auth-needed signal) rather than parking this ticket alone as an opaque hard-fail.
  it('an auth-expired failed session halts the batch instead of parking the ticket, naming re-auth as the fix', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'failed', terminalReason: 'auth-expired', retryCap: 2 });
    expect(a.type).toBe('halt-auth-expired');
    expect((a as { reason: string }).reason).toMatch(/claude login|refresh the api key/i);
  });
  it('an auth-expired failure while REVIEWING also halts (not just implementing)', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'failed', terminalReason: 'auth-expired', retryCap: 2 });
    expect(a.type).toBe('halt-auth-expired');
  });
  it('a cooling-down ticket waits until its next retry time', () => {
    const now = 1_000_000;
    const ticket = mkTicket({ state: 'cooling-down', rateLimitFirstSeenAt: new Date(now).toISOString(), nextRetryAt: new Date(now + 20 * 60_000).toISOString(), preCooldownState: 'implementing' });
    const a = decideTicketAction({ ticket, retryCap: 2, nowMs: now + 60_000, rateLimitRetryIntervalMs: 20 * 60_000, rateLimitMaxWaitMs: 5 * 3_600_000 });
    expect(a.type).toBe('wait');
  });
  it('a cooling-down ticket retries once its retry window elapses (restoring its phase)', () => {
    const now = 1_000_000;
    const ticket = mkTicket({ state: 'cooling-down', rateLimitFirstSeenAt: new Date(now).toISOString(), nextRetryAt: new Date(now + 20 * 60_000).toISOString(), rateLimitAttempts: 1, preCooldownState: 'reviewing' });
    const a = decideTicketAction({ ticket, retryCap: 2, nowMs: now + 21 * 60_000, rateLimitRetryIntervalMs: 20 * 60_000, rateLimitMaxWaitMs: 5 * 3_600_000 });
    expect(a).toEqual({ type: 'retry-rate-limited', phase: 'review', attempt: 2 });
  });
  it('a cooling-down ticket parks once it exceeds the max-wait ceiling', () => {
    const now = 1_000_000;
    const ticket = mkTicket({ state: 'cooling-down', rateLimitFirstSeenAt: new Date(now).toISOString(), nextRetryAt: new Date(now).toISOString(), preCooldownState: 'implementing' });
    const a = decideTicketAction({ ticket, retryCap: 2, nowMs: now + 5 * 3_600_000 + 1, rateLimitRetryIntervalMs: 20 * 60_000, rateLimitMaxWaitMs: 5 * 3_600_000 });
    expect(a.type).toBe('park');
  });

  // FLUX-1156: a failed/cancelled park reason folds in the session's own recorded outcome (e.g. a
  // pre-spawn failure's "session failed to start: <reason>") instead of staying opaque.
  it('a failed session with no recorded outcome parks with the generic reason', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'failed', retryCap: 2 });
    expect(a).toEqual({ type: 'park', reason: 'the implementation session ended failed', failureClass: 'hard-fail' });
  });
  it('a failed session with a recorded outcome folds it into the park reason', () => {
    const a = decideTicketAction({
      ticket: mkTicket({ state: 'implementing' }),
      sessionStatus: 'failed',
      sessionOutcome: 'Claude Code session failed to start: refusing to run the agent on master',
      retryCap: 2,
    });
    expect(a).toEqual({
      type: 'park',
      reason: 'the implementation session ended failed — Claude Code session failed to start: refusing to run the agent on master',
      failureClass: 'hard-fail',
    });
  });
  it('a cancelled session with a recorded outcome folds it in too', () => {
    const a = decideTicketAction({
      ticket: mkTicket({ state: 'reviewing' }),
      sessionStatus: 'cancelled',
      sessionOutcome: 'Claude Code session stopped by user.',
      retryCap: 2,
    });
    expect(a.type).toBe('park');
    expect((a as { reason: string }).reason).toBe('the review session ended cancelled — Claude Code session stopped by user.');
  });

  // FLUX-1297: a cancelled session (a deliberate stop, not a crash) whose ticket already reads a
  // merged/terminal board status means a finish/merge flow killed the session on purpose because the
  // work already landed — yield instead of parking a ticket that already succeeded.
  it('yields (does not park) a cancelled session when the ticket board status is already Done', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'cancelled', ticketStatus: 'Done', retryCap: 2 });
    expect(a).toEqual({ type: 'yield', reason: 'the review session was stopped and the ticket is already Done' });
  });
  it('yields a cancelled session when the ticket board status is already Released', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'cancelled', ticketStatus: 'Released', retryCap: 2 });
    expect(a.type).toBe('yield');
  });
  it('still parks a cancelled session when the ticket board status is NOT merged/terminal', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'cancelled', ticketStatus: 'In Progress', retryCap: 2 });
    expect(a.type).toBe('park');
  });
  it('still parks a cancelled session with no ticketStatus at all (unknown board state)', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'cancelled', retryCap: 2 });
    expect(a.type).toBe('park');
  });
  it('a FAILED (crashed) session still parks even when the ticket board status already reads Done — only a deliberate cancel yields', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'failed', ticketStatus: 'Done', retryCap: 2 });
    expect(a.type).toBe('park');
  });
});

// FLUX-1396 (Group B): additional decideTicketAction edge cases the earlier per-ticket tickets didn't
// pin down explicitly — precise park reasons, branch-precedence (a session outcome wins over a stale
// verdict), and a couple of matrix cells (scheduled/waiting-input/cancelled/undefined-session) asserted
// with full-shape `toEqual` rather than a loose `type` check, so a future refactor can't quietly change
// the reason text or failure class without a test noticing.
describe('FLUX-1396 (Group B) — decideTicketAction matrix', () => {
  // Item 6: a completed review with no verdict at all (no marker-nudge in play) must park with the exact
  // "no verdict" reason — this is the ScheduleWakeup-false-park class of bug: a caller that mistakenly
  // treats this as some other park class (e.g. a bogus needs-input) would silently change behavior.
  // FLUX-1437: the FIRST such completion gets a `review-retry` instead (see the pure-decision-core
  // tests above) — this asserts the exact park reason/class once the one-shot retry budget is spent
  // (`reviewNudgeSent: true`), which is the only way this decision still reaches a real park.
  it('a completed review with reviewState null parks with the exact "no verdict" reason', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing', reviewNudgeSent: true }), sessionStatus: 'completed', reviewState: null, retryCap: 2 });
    expect(a).toEqual({ type: 'park', reason: 'review completed without a verdict (reviewState unset)', failureClass: 'hard-fail' });
  });
  it('a completed review with reviewState left undefined (never even cleared) parks the same way', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing', reviewNudgeSent: true }), sessionStatus: 'completed', retryCap: 2 });
    expect(a).toEqual({ type: 'park', reason: 'review completed without a verdict (reviewState unset)', failureClass: 'hard-fail' });
  });

  // Item 7: the `sessionStatus === 'failed'` branch (furnace-stoker.ts ~line 296) sits BEFORE the
  // verdict-read branch (~line 318) and must win outright — a STALE reviewState left on the ticket from a
  // prior review round (persists across re-implementation by design — see `clearReviewState`) must never
  // be misread as this round's verdict just because the session that was supposed to update it crashed.
  it('a FAILED session with a stale reviewState="approved" still hard-fails — never a false pr-open', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'failed', reviewState: 'approved', retryCap: 2 });
    expect(a).toEqual({ type: 'park', reason: 'the review session ended failed', failureClass: 'hard-fail' });
  });
  it('a FAILED session with a stale reviewState="changes-requested" still hard-fails — never a false reimplement', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing', attempts: 0 }), sessionStatus: 'failed', reviewState: 'changes-requested', retryCap: 2 });
    expect(a).toEqual({ type: 'park', reason: 'the review session ended failed', failureClass: 'hard-fail' });
  });

  // Item 8: the session-status matrix, locked with full-shape equality.
  describe('session-status matrix', () => {
    it('scheduled (an honored ScheduleWakeup sleep) waits, never a false "no verdict" park', () => {
      expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'scheduled', retryCap: 2 })).toEqual({ type: 'wait' });
    });
    it('waiting-input parks needs-input (an unattended run cannot answer)', () => {
      expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'waiting-input', retryCap: 2 }))
        .toEqual({ type: 'park', reason: 'the implementation session is waiting for input (an unattended run can\'t answer)', failureClass: 'needs-input' });
    });
    it('cancelled + ticket already Done (FLUX-1297) yields instead of parking', () => {
      expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'cancelled', ticketStatus: 'Done', retryCap: 2 }))
        .toEqual({ type: 'yield', reason: 'the implementation session was stopped and the ticket is already Done' });
    });
    it('FLUX-1297 nuance: cancelled + ticketStatus="Archived" still PARKS — Archived counts as board-success elsewhere but is NOT "merged" for this yield check', () => {
      expect(decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'cancelled', ticketStatus: 'Archived', retryCap: 2 }).type).toBe('park');
    });
    it('undefined session status (no observable session) cold-redrives the current phase', () => {
      expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), retryCap: 2 })).toEqual({ type: 'redrive', phase: 'implementation' });
      expect(decideTicketAction({ ticket: mkTicket({ state: 'reimplementing' }), retryCap: 2 })).toEqual({ type: 'redrive', phase: 'implementation' });
    });
  });

  // Item 9: context-exhaustion retry/park boundary, plus a rate-limit cooldown entered from `reviewing`
  // (the existing coverage only exercised it from `implementing`).
  describe('exhaustion + rate-limit boundaries', () => {
    it('retries under the exhaustion cap, parks exactly AT the cap (not one past it)', () => {
      const underCap = decideTicketAction({ ticket: mkTicket({ state: 'implementing', exhaustionAttempts: 1 }), sessionStatus: 'failed', terminalReason: 'context-exhausted', retryCap: 2, exhaustionRetryCap: 2 });
      expect(underCap).toEqual({ type: 'retry-exhausted', phase: 'implementation', attempt: 2 });
      const atCap = decideTicketAction({ ticket: mkTicket({ state: 'implementing', exhaustionAttempts: 2 }), sessionStatus: 'failed', terminalReason: 'context-exhausted', retryCap: 2, exhaustionRetryCap: 2 });
      expect(atCap).toEqual({ type: 'park', reason: 'the implementation session ran out of context 2 time(s) — retries spent', failureClass: 'hard-fail' });
    });
    it('a rate-limited failure while REVIEWING also cools down (not just implementing)', () => {
      const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'failed', terminalReason: 'rate-limited', retryCap: 2 });
      expect(a).toEqual({ type: 'cooldown-rate-limited' });
    });
  });

  // Item 10: the FLUX-1078 review-nudge is capped at exactly one — model the real two-call sequence
  // `advanceTicket`'s 'review-nudge' case produces (it sets `reviewNudgeSent = true` once it dispatches
  // the corrective session), rather than two independently-constructed tickets.
  it('review-nudge fires once for a fresh ticket, then the SAME ticket (now reviewNudgeSent) falls back to park on the next pass', () => {
    const fresh = mkTicket({ state: 'reviewing' });
    const first = decideTicketAction({ ticket: fresh, sessionStatus: 'completed', reviewState: null, reviewVerdictMarkerSeen: true, retryCap: 2 });
    expect(first).toEqual({ type: 'review-nudge' });

    // Mirrors advanceTicket's 'review-nudge' mutation before the follow-up session is dispatched.
    const afterNudgeDispatched = { ...fresh, reviewNudgeSent: true };
    const second = decideTicketAction({ ticket: afterNudgeDispatched, sessionStatus: 'completed', reviewState: null, reviewVerdictMarkerSeen: true, retryCap: 2 });
    expect(second).toEqual({ type: 'park', reason: 'review completed without a verdict (reviewState unset)', failureClass: 'hard-fail' });
  });
});

describe('findSessionOutcome (FLUX-1156)', () => {
  it('returns undefined when the task or session id is missing', () => {
    expect(findSessionOutcome(undefined, 's1')).toBeUndefined();
    expect(findSessionOutcome({ history: [] }, undefined)).toBeUndefined();
  });
  it('returns undefined when no agent_session entry matches the session id', () => {
    const task = { history: [{ type: 'agent_session', sessionId: 'other', outcome: 'nope' }] };
    expect(findSessionOutcome(task, 's1')).toBeUndefined();
  });
  it('returns the matching entry outcome, trimmed', () => {
    const task = { history: [{ type: 'agent_session', sessionId: 's1', outcome: '  session failed to start: worktree pool full  ' }] };
    expect(findSessionOutcome(task, 's1')).toBe('session failed to start: worktree pool full');
  });
  it('prefers the LATEST matching entry when a session id repeats', () => {
    const task = {
      history: [
        { type: 'agent_session', sessionId: 's1', outcome: 'first' },
        { type: 'agent_session', sessionId: 's1', outcome: 'second' },
      ],
    };
    expect(findSessionOutcome(task, 's1')).toBe('second');
  });
});

// FLUX-1078: narrow pattern-match on the known review-verdict convention (every built-in reviewer
// persona starts its comment with **APPROVED** or **CHANGES NEEDED**) — not a general classifier.
describe('lastCommentMatchesVerdictMarker', () => {
  it('matches the last comment when it starts with a known verdict marker', () => {
    expect(lastCommentMatchesVerdictMarker([{ type: 'comment', comment: '**APPROVED**\n\nLooks good.' }])).toBe(true);
    expect(lastCommentMatchesVerdictMarker([{ type: 'comment', comment: '**CHANGES NEEDED**\n\nSee below.' }])).toBe(true);
    expect(lastCommentMatchesVerdictMarker([{ type: 'comment', comment: '  **approved**' }])).toBe(true);
  });
  it('ignores non-comment entries and only looks at the LAST comment', () => {
    expect(lastCommentMatchesVerdictMarker([
      { type: 'comment', comment: '**APPROVED**' },
      { type: 'activity', comment: 'unrelated' },
      { type: 'comment', comment: 'just a status update, no verdict' },
    ])).toBe(false);
  });
  it('does not match prose that merely mentions a verdict word', () => {
    expect(lastCommentMatchesVerdictMarker([{ type: 'comment', comment: 'This looks approved to me.' }])).toBe(false);
  });
  it('handles missing/malformed history', () => {
    expect(lastCommentMatchesVerdictMarker(undefined)).toBe(false);
    expect(lastCommentMatchesVerdictMarker([])).toBe(false);
    expect(lastCommentMatchesVerdictMarker([{ type: 'comment', comment: 123 }])).toBe(false);
  });

  // FLUX-1080: a `sinceIso` cutoff scopes the scan to the CURRENT review pass so a verdict-shaped comment
  // left over from a prior round (before a changes-requested re-implementation) can't be mistaken for this
  // round's verdict.
  describe('sinceIso scoping (FLUX-1080)', () => {
    it('ignores a stale pre-cutoff verdict comment even though it is the only comment in history', () => {
      const history = [
        { type: 'comment', comment: '**CHANGES NEEDED**\n\nFix the thing.', date: '2026-07-01T00:00:00.000Z' },
      ];
      expect(lastCommentMatchesVerdictMarker(history, '2026-07-02T00:00:00.000Z')).toBe(false);
    });
    it('still matches a fresh verdict comment posted after the cutoff', () => {
      const history = [
        { type: 'comment', comment: '**CHANGES NEEDED**', date: '2026-07-01T00:00:00.000Z' },
        { type: 'comment', comment: '**APPROVED**', date: '2026-07-03T00:00:00.000Z' },
      ];
      expect(lastCommentMatchesVerdictMarker(history, '2026-07-02T00:00:00.000Z')).toBe(true);
    });
    it('does not fall through to an older comment when the newest post-cutoff comment has no verdict marker', () => {
      const history = [
        { type: 'comment', comment: '**APPROVED**', date: '2026-07-01T00:00:00.000Z' },
        { type: 'comment', comment: 'looks fine, no marker here', date: '2026-07-03T00:00:00.000Z' },
      ];
      expect(lastCommentMatchesVerdictMarker(history, '2026-07-02T00:00:00.000Z')).toBe(false);
    });
    it('is unscoped (matches the last comment regardless of date) when sinceIso is omitted', () => {
      const history = [{ type: 'comment', comment: '**APPROVED**', date: '2020-01-01T00:00:00.000Z' }];
      expect(lastCommentMatchesVerdictMarker(history)).toBe(true);
    });
  });
});

// FLUX-1066: parks carry a failure CLASS (needs-input vs hard-fail), and a taken-over ticket is settled.
describe('FLUX-1066 — failure taxonomy + ownership', () => {
  it('classifies park causes by failure class', () => {
    expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'waiting-input', retryCap: 2 }))
      .toMatchObject({ type: 'park', failureClass: 'needs-input' });
    expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'completed', ticketStatus: 'Require Input', requireInputStatus: 'Require Input', retryCap: 2 }))
      .toMatchObject({ type: 'park', failureClass: 'needs-input' });
    expect(decideTicketAction({ ticket: mkTicket({ state: 'reviewing', attempts: 2 }), sessionStatus: 'completed', reviewState: 'changes-requested', retryCap: 2 }))
      .toMatchObject({ type: 'park', failureClass: 'needs-input' });
    expect(decideTicketAction({ ticket: mkTicket({ state: 'implementing' }), sessionStatus: 'failed', retryCap: 2 }))
      .toMatchObject({ type: 'park', failureClass: 'hard-fail' });
    // FLUX-1437: the first no-verdict completion gets a `review-retry`, not a park — spend the
    // one-shot budget (`reviewNudgeSent: true`) to reach the actual park this test classifies.
    expect(decideTicketAction({ ticket: mkTicket({ state: 'reviewing', reviewNudgeSent: true }), sessionStatus: 'completed', reviewState: null, retryCap: 2 }))
      .toMatchObject({ type: 'park', failureClass: 'hard-fail' });
  });
  it('treats a human-owned ticket as settled so it cannot wedge the batch', () => {
    expect(isHumanOwned(mkTicket({ owner: 'human' }))).toBe(true);
    expect(isHumanOwned(mkTicket())).toBe(false);
    expect(isSettledTicket(mkTicket({ state: 'implementing', owner: 'human' }))).toBe(true);
    expect(isSettledTicket(mkTicket({ state: 'implementing' }))).toBe(false);
    const b = mkBatch({ tickets: [mkTicket({ ticketId: 'A', state: 'pr-open' }), mkTicket({ ticketId: 'B', state: 'implementing', owner: 'human' })] });
    expect(allTicketsSettled(b)).toBe(true);
    expect(allTicketsTerminal(b)).toBe(false);
  });
});

describe('watchdog + circuit breaker', () => {
  it('flags a session past the timeout', () => {
    const t = mkTicket({ state: 'implementing', sessionStartedAt: '2026-07-02T00:00:00.000Z' });
    const now = Date.parse('2026-07-02T01:00:00.000Z');
    expect(isSessionTimedOut(t, 45 * 60 * 1000, now)).toBe(true);
    expect(isSessionTimedOut(t, 0, now)).toBe(false);
    expect(isSessionTimedOut(mkTicket({ state: 'queued' }), 1000, now)).toBe(false);
  });
  it('trips the breaker at the threshold', () => {
    expect(breakerTripped(mkBatch({ consecutiveFailures: 3, maxConsecutiveFailures: 3 }))).toBe(true);
    expect(breakerTripped(mkBatch({ consecutiveFailures: 2, maxConsecutiveFailures: 3 }))).toBe(false);
  });
});

describe('queue helpers + report', () => {
  it('nextQueuedTicket picks the lowest-order queued ticket', () => {
    const b = mkBatch({ tickets: [mkTicket({ ticketId: 'A', order: 0, state: 'pr-open' }), mkTicket({ ticketId: 'B', order: 1, state: 'queued' })] });
    expect(nextQueuedTicket(b)?.ticketId).toBe('B');
  });
  it('allTicketsTerminal is true only when every ticket is terminal', () => {
    expect(allTicketsTerminal(mkBatch({ tickets: [mkTicket({ state: 'pr-open' }), mkTicket({ state: 'parked' })] }))).toBe(true);
    expect(allTicketsTerminal(mkBatch({ tickets: [mkTicket({ state: 'pr-open' }), mkTicket({ state: 'queued' })] }))).toBe(false);
  });
  it('assembleBurnReport tallies PRs, parks, and failures', () => {
    const b = mkBatch({
      ignitedAt: '2026-07-02T00:00:00.000Z',
      tickets: [
        mkTicket({ ticketId: 'A', state: 'pr-open', prUrl: 'http://pr/1' }),
        mkTicket({ ticketId: 'B', state: 'parked', note: 'needs input' }),
        mkTicket({ ticketId: 'C', state: 'failed', note: 'boom' }),
      ],
    });
    const rep = assembleBurnReport(b, '2026-07-02T00:30:00.000Z');
    expect(rep.prsOpened).toHaveLength(1);
    expect(rep.parked).toHaveLength(1);
    expect(rep.failed).toHaveLength(1);
    expect(rep.processed).toBe(3);
    expect(rep.durationMs).toBe(30 * 60 * 1000);
  });
  it('FLUX-1210: assembleBurnReport splits an already-merged pr-open ticket out of prsOpened', () => {
    const b = mkBatch({
      tickets: [
        mkTicket({ ticketId: 'A', state: 'pr-open', prUrl: 'http://pr/1' }), // still awaiting merge
        mkTicket({ ticketId: 'B', state: 'pr-open', prUrl: 'http://pr/2', mergedAt: '2026-07-02T00:10:00.000Z' }),
      ],
    });
    const rep = assembleBurnReport(b, '2026-07-02T00:30:00.000Z');
    expect(rep.prsOpened.map((l) => l.ticketId)).toEqual(['A']);
    expect(rep.merged.map((l) => l.ticketId)).toEqual(['B']);
    expect(rep.nextActions).toEqual(['Review 1 open PR(s) and merge the good ones.']);
  });
});

// FLUX-1066 (M5): the state-transition cores behind the reconciling controller — B1 (flag drop on
// takeover), M1 (identity-based takeover detection), M2 (retry pr-open guard), M3 (slot accounting),
// M4 (only hard-fail feeds the breaker). Exercised as pure functions the async controllers delegate to.
describe('FLUX-1066 — isHumanTakeover (M1: identity, not phase; ignores stalled waiting-input)', () => {
  const ticket = mkTicket({ sessionIds: ['furnace-impl', 'furnace-review'] });
  it('a running session the Furnace does not track is a takeover', () => {
    expect(isHumanTakeover([{ id: 'chat-1', status: 'running', phase: 'chat' }], ticket)).toBe(true);
  });
  it('a human-started implementation/review session (untracked id) is still a takeover', () => {
    expect(isHumanTakeover([{ id: 'human-impl', status: 'running', phase: 'implementation' }], ticket)).toBe(true);
    expect(isHumanTakeover([{ id: 'human-review', status: 'pending', phase: 'review' }], ticket)).toBe(true);
  });
  it('a Furnace-tracked session is never a takeover', () => {
    expect(isHumanTakeover([{ id: 'furnace-impl', status: 'running', phase: 'implementation' }], ticket)).toBe(false);
  });
  it('a stalled waiting-input session does NOT count as a takeover (no expiry footgun)', () => {
    expect(isHumanTakeover([{ id: 'stale', status: 'waiting-input', phase: 'chat' }], ticket)).toBe(false);
  });
  it('no live sessions → no takeover', () => {
    expect(isHumanTakeover([], ticket)).toBe(false);
  });
  it('FLUX-1090: a dispatching ticket is never a takeover, even with a live untracked session (the Furnace\'s own in-flight spawn)', () => {
    expect(isHumanTakeover([{ id: 'not-yet-recorded', status: 'running', phase: 'implementation' }], ticket, true)).toBe(false);
  });
  it('FLUX-1090: isDispatching defaults to false (existing callers unaffected)', () => {
    expect(isHumanTakeover([{ id: 'human-impl', status: 'running', phase: 'implementation' }], ticket)).toBe(true);
  });
});

describe('FLUX-1066 — decideReconcile (B1: takeover + board-success both drop the flag)', () => {
  it('an auto-detected takeover flips owner→human AND drops the board flag (B1)', () => {
    expect(decideReconcile(mkTicket({ state: 'parked' }), { takenOver: true, boardSuccess: false }))
      .toEqual({ ticketId: 'FLUX-1', owner: 'human', dropFlag: true });
  });
  it('does not re-flag a ticket already human-owned', () => {
    expect(decideReconcile(mkTicket({ state: 'parked', owner: 'human' }), { takenOver: true, boardSuccess: false }))
      .toBeNull();
  });
  it('a board-success ticket reflects pr-open with its PR url and drops the flag', () => {
    expect(decideReconcile(mkTicket({ state: 'parked' }), { takenOver: false, boardSuccess: true, prUrl: 'http://pr/1' }))
      .toEqual({ ticketId: 'FLUX-1', reflectPrOpen: true, prUrl: 'http://pr/1', dropFlag: true });
  });
  it('board-success wins over a takeover (the ticket is done, not being driven)', () => {
    expect(decideReconcile(mkTicket({ state: 'failed' }), { takenOver: true, boardSuccess: true }))
      .toMatchObject({ reflectPrOpen: true, dropFlag: true });
  });
  it('an already pr-open / skipped ticket is not re-reflected', () => {
    expect(decideReconcile(mkTicket({ state: 'pr-open' }), { takenOver: false, boardSuccess: true })).toBeNull();
    expect(decideReconcile(mkTicket({ state: 'skipped' }), { takenOver: false, boardSuccess: true })).toBeNull();
  });
  it('nothing changed → null', () => {
    expect(decideReconcile(mkTicket({ state: 'parked' }), { takenOver: false, boardSuccess: false })).toBeNull();
  });
});

describe('FLUX-1210 — decideReconcile detects a pr-open ticket merged outside the Furnace', () => {
  it('flags markMerged once the board flips to Done/Released', () => {
    expect(decideReconcile(mkTicket({ state: 'pr-open' }), { takenOver: false, boardSuccess: true, boardMerged: true }))
      .toEqual({ ticketId: 'FLUX-1', markMerged: true });
  });
  it('a pr-open ticket still at Ready (board-success but not merged) is left alone', () => {
    expect(decideReconcile(mkTicket({ state: 'pr-open' }), { takenOver: false, boardSuccess: true, boardMerged: false }))
      .toBeNull();
  });
  it('does not re-flag a ticket already marked merged', () => {
    expect(decideReconcile(mkTicket({ state: 'pr-open', mergedAt: '2026-07-02T00:00:00.000Z' }), { takenOver: false, boardSuccess: true, boardMerged: true }))
      .toBeNull();
  });
  it('a non-pr-open ticket is unaffected by boardMerged (reflectPrOpen wins)', () => {
    expect(decideReconcile(mkTicket({ state: 'parked' }), { takenOver: false, boardSuccess: true, boardMerged: true, prUrl: 'http://pr/1' }))
      .toEqual({ ticketId: 'FLUX-1', reflectPrOpen: true, prUrl: 'http://pr/1', dropFlag: true });
  });
});

describe('FLUX-1066 — retryRejectionReason (M2: pr-open guard)', () => {
  it('rejects a still-burning ticket', () => {
    expect(retryRejectionReason(mkTicket({ state: 'implementing' }), false)).toMatch(/still burning/);
  });
  it('rejects a pr-open ticket (would drop the open PR + duplicate the burn)', () => {
    expect(retryRejectionReason(mkTicket({ state: 'pr-open' }), false)).toMatch(/open PR/);
  });
  it('allows a FORCED pr-open retry (the explicit hand-back path)', () => {
    expect(retryRejectionReason(mkTicket({ state: 'pr-open' }), true)).toBeNull();
  });
  it('allows a parked/failed retry', () => {
    expect(retryRejectionReason(mkTicket({ state: 'parked' }), false)).toBeNull();
    expect(retryRejectionReason(mkTicket({ state: 'failed' }), false)).toBeNull();
  });
  it('FLUX-1090: a FORCED retry also bypasses the still-burning guard (handBackTicket stops the session first)', () => {
    expect(retryRejectionReason(mkTicket({ state: 'implementing' }), true)).toBeNull();
    expect(retryRejectionReason(mkTicket({ state: 'reviewing' }), true)).toBeNull();
  });
});

describe('FLUX-1066 — countsTowardBreaker (M4: only hard-fail trips the breaker)', () => {
  it('a hard-fail counts', () => {
    expect(countsTowardBreaker('hard-fail')).toBe(true);
  });
  it('a needs-input park does NOT (legit human question must not halt the batch)', () => {
    expect(countsTowardBreaker('needs-input')).toBe(false);
  });
  it('transient / recoverable do not count', () => {
    expect(countsTowardBreaker('transient')).toBe(false);
    expect(countsTowardBreaker('recoverable')).toBe(false);
  });
});

describe('FLUX-1066 — slot accounting (M3: independent + reservations, not max)', () => {
  it('a reservation not yet backed by an on-disk worktree + an independent worktree = 2 (max() undercounted to 1)', () => {
    expect(computeSlotsInUse(['Y'], { count: 1, ticketIds: ['X'] })).toBe(2);
  });
  it('a reservation already backed by its worktree is counted once (no double-count)', () => {
    expect(computeSlotsInUse(['Y'], { count: 1, ticketIds: ['Y'] })).toBe(1);
  });
  it('purely independent observed worktrees (no reservations) count as-is', () => {
    expect(computeSlotsInUse([], { count: 2, ticketIds: ['A', 'B'] })).toBe(2);
  });
  it('an observed worktree whose path did not resolve to a ticket is still an independent slot', () => {
    // count 2 but only Y resolved (and Y is backed) → the unresolved worktree is independent.
    expect(computeSlotsInUse(['Y'], { count: 2, ticketIds: ['Y'] })).toBe(2);
  });
  it('furnaceReservedTicketIds: parallel lists active+cooling, sequential lists the anchor only', () => {
    const par = mkBatch({ kind: 'parallel', status: 'burning', tickets: [
      mkTicket({ ticketId: 'A', state: 'implementing' }),
      mkTicket({ ticketId: 'B', state: 'cooling-down' }),
      mkTicket({ ticketId: 'C', state: 'queued' }),
    ] });
    expect(furnaceReservedTicketIds(par).sort()).toEqual(['A', 'B']);
    const seq = mkBatch({ kind: 'sequential', status: 'burning', tickets: [
      mkTicket({ ticketId: 'A', order: 0, state: 'reviewing' }),
      mkTicket({ ticketId: 'B', order: 1, state: 'queued' }),
    ] });
    expect(furnaceReservedTicketIds(seq)).toEqual(['A']);
    expect(furnaceReservedTicketIds(mkBatch({ status: 'draft', tickets: [mkTicket({ state: 'implementing' })] }))).toEqual([]);
  });
});

describe('isTriggerSatisfied', () => {
  it('a batch with no trigger is never satisfied', () => {
    expect(isTriggerSatisfied(mkBatch())).toBe(false);
  });
  it('a pr trigger is satisfied when a matching PR is merged (checked against the live cache in the stoker)', () => {
    // Pure structural check: with no matching PR in the (empty) cache, it is not satisfied.
    const b = mkBatch({ trigger: { type: 'pr', ref: 'http://pr/999' } });
    expect(isTriggerSatisfied(b)).toBe(false);
  });
});

describe('validateBatchTrigger (FLUX-1142)', () => {
  it('allows no trigger, and a pr-type trigger unconditionally (no batch id to cycle on)', () => {
    expect(validateBatchTrigger('A', null, [])).toBeNull();
    expect(validateBatchTrigger('A', undefined, [])).toBeNull();
    expect(validateBatchTrigger('A', { type: 'pr', ref: '#123' }, [mkBatch({ id: 'A' })])).toBeNull();
  });
  it('rejects a batch triggering off itself', () => {
    expect(validateBatchTrigger('A', { type: 'batch', ref: 'A' }, [mkBatch({ id: 'A' })])).toMatch(/itself/);
  });
  it('rejects a direct A→B→A cycle (B already triggers after A)', () => {
    const a = mkBatch({ id: 'A', title: 'Batch A' });
    const b = mkBatch({ id: 'B', title: 'Batch B', trigger: { type: 'batch', ref: 'A' } });
    expect(validateBatchTrigger('A', { type: 'batch', ref: 'B' }, [a, b])).toMatch(/cycle/);
  });
  it('allows A to trigger after B when B does not trigger after A', () => {
    const a = mkBatch({ id: 'A' });
    const b = mkBatch({ id: 'B' }); // no trigger
    expect(validateBatchTrigger('A', { type: 'batch', ref: 'B' }, [a, b])).toBeNull();
  });
  it('allows referencing a batch id that does not (yet) exist — resolved-as-deleted is a display concern, not a validation one', () => {
    expect(validateBatchTrigger('A', { type: 'batch', ref: 'ghost' }, [mkBatch({ id: 'A' })])).toBeNull();
  });
  it('FLUX-1181: rejects arming a trigger on a batch that is not draft (burning/parked/done) — the Stoker only evaluates draft batches', () => {
    for (const status of ['burning', 'parked', 'done'] as const) {
      const a = mkBatch({ id: 'A', status });
      expect(validateBatchTrigger('A', { type: 'pr', ref: '#123' }, [a])).toMatch(/draft/);
      expect(validateBatchTrigger('A', { type: 'batch', ref: 'B' }, [a, mkBatch({ id: 'B' })])).toMatch(/draft/);
    }
  });
  it('FLUX-1181: still allows clearing (null) a trigger regardless of batch status', () => {
    const a = mkBatch({ id: 'A', status: 'parked', trigger: { type: 'pr', ref: '#123' } });
    expect(validateBatchTrigger('A', null, [a])).toBeNull();
  });
});

// FLUX-1057 (folded in from the archived FLUX-1049): verdict-gating for mirroring a reviewer's verdict
// onto the real GitHub PR. `pickPrReview` is already the pure decision core the ticket asked to extract
// (as `pickMirrorVerdict`) — these cases lock its gating; `mirrorReviewVerdictToPr` wraps it with the
// no-prUrl short-circuit and the actual (mocked) post.
describe('pickPrReview / mirrorReviewVerdictToPr (verdict-gating)', () => {
  it('pr-open on a parallel batch mirrors a formal approve (not comment-only)', () => {
    const b = mkBatch({ kind: 'parallel' });
    const t = mkTicket({ state: 'reviewing' });
    expect(pickPrReview(b, t, { type: 'pr-open', prUrl: 'http://pr/1' }, 'approved'))
      .toEqual({ verdict: 'approved', commentOnly: false });
  });

  it('pr-open on a sequential batch comments-only until the FINAL ticket approves', () => {
    const notFinal = mkBatch({
      kind: 'sequential',
      tickets: [mkTicket({ ticketId: 'A', order: 0 }), mkTicket({ ticketId: 'B', order: 1 })],
    });
    // B is highest-order, but sibling A hasn't recorded an approved verdict yet — not the final approval.
    expect(pickPrReview(notFinal, notFinal.tickets[1]!, { type: 'pr-open', prUrl: 'http://pr/1' }, 'approved'))
      .toEqual({ verdict: 'approved', commentOnly: true });

    const final = mkBatch({
      kind: 'sequential',
      tickets: [mkTicket({ ticketId: 'A', order: 0, lastReviewState: 'approved' }), mkTicket({ ticketId: 'B', order: 1 })],
    });
    expect(pickPrReview(final, final.tickets[1]!, { type: 'pr-open', prUrl: 'http://pr/1' }, 'approved'))
      .toEqual({ verdict: 'approved', commentOnly: false });
  });

  it('reviewing + changes-requested + reimplement mirrors changes-requested', () => {
    const t = mkTicket({ state: 'reviewing', attempts: 1 });
    expect(pickPrReview(mkBatch(), t, { type: 'reimplement', attempt: 2 }, 'changes-requested'))
      .toEqual({ verdict: 'changes-requested', commentOnly: false });
  });

  it('a retryCap park with changes-requested still mirrors changes-requested', () => {
    const t = mkTicket({ state: 'reviewing', attempts: 2 });
    const action = { type: 'park' as const, reason: 'review still requesting changes after 2 re-implementation attempt(s)', failureClass: 'needs-input' as const };
    expect(pickPrReview(mkBatch(), t, action, 'changes-requested')).toEqual({ verdict: 'changes-requested', commentOnly: false });
  });

  it('a park from a failed/waiting-input session with reviewState cleared (null) mirrors nothing', () => {
    const t = mkTicket({ state: 'implementing' });
    const action = { type: 'park' as const, reason: 'the implementation session ended failed', failureClass: 'hard-fail' as const };
    expect(pickPrReview(mkBatch(), t, action, null)).toBeNull();
  });

  it('a park while still implementing mirrors nothing, even with a stale changes-requested reviewState', () => {
    const t = mkTicket({ state: 'implementing' });
    const action = { type: 'park' as const, reason: 'x', failureClass: 'hard-fail' as const };
    expect(pickPrReview(mkBatch(), t, action, 'changes-requested')).toBeNull();
  });

  it('mirrorReviewVerdictToPr posts nothing — and never calls postPrReview — when there is no PR url', async () => {
    postPrReview.mockClear();
    const t = mkTicket({ state: 'reviewing' });
    await mirrorReviewVerdictToPr(mkBatch(), { type: 'pr-open', prUrl: 'http://pr/1' }, t.ticketId, t, 'approved', undefined);
    expect(postPrReview).not.toHaveBeenCalled();
  });

  it('mirrorReviewVerdictToPr posts a single approve when a PR url is present', async () => {
    postPrReview.mockClear();
    const t = mkTicket({ state: 'reviewing' });
    await mirrorReviewVerdictToPr(mkBatch({ kind: 'parallel' }), { type: 'pr-open', prUrl: 'http://pr/1' }, t.ticketId, t, 'approved', 'http://pr/1');
    expect(postPrReview).toHaveBeenCalledTimes(1);
    expect(postPrReview).toHaveBeenCalledWith('http://pr/1', 'approved', expect.any(String), { commentOnly: false });
  });
});

describe('FLUX-1223 — upsertBatchPr accumulates every ticket that lands on a sequential shared PR', () => {
  it('a fresh PR entry seeds both ticketId and ticketIds', () => {
    const b = mkBatch({ kind: 'sequential' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-1', reviewState: 'approved' });
    expect(b.prs).toEqual([{ url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-1', ticketIds: ['FLUX-1'], reviewState: 'approved' }]);
  });

  it('a second ticket on the SAME branch accumulates into ticketIds instead of overwriting it', () => {
    const b = mkBatch({ kind: 'sequential' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-1', reviewState: 'approved' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-2', reviewState: 'approved' });
    expect(b.prs).toHaveLength(1);
    expect(b.prs[0]!.ticketIds).toEqual(['FLUX-1', 'FLUX-2']);
    // ticketId still tracks the most-recent ticket to land — the "which one to re-implement" pointer.
    expect(b.prs[0]!.ticketId).toBe('FLUX-2');
  });

  it('re-processing the same ticket again is idempotent (no duplicate entries in ticketIds)', () => {
    const b = mkBatch({ kind: 'sequential' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-1', reviewState: 'approved' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-2', reviewState: 'approved' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/seq', ticketId: 'FLUX-2', reviewState: 'changes_requested' });
    expect(b.prs).toHaveLength(1);
    expect(b.prs[0]!.ticketIds).toEqual(['FLUX-1', 'FLUX-2']);
    expect(b.prs[0]!.reviewState).toBe('changes_requested');
  });

  it('a parallel batch keeps one PR per ticket (dedup by ticketId, not branch)', () => {
    const b = mkBatch({ kind: 'parallel' });
    upsertBatchPr(b, { url: 'http://pr/1', branch: 'flux/a', ticketId: 'FLUX-1', reviewState: 'approved' });
    upsertBatchPr(b, { url: 'http://pr/2', branch: 'flux/b', ticketId: 'FLUX-2', reviewState: 'approved' });
    expect(b.prs).toHaveLength(2);
    expect(b.prs.map((p) => p.ticketIds)).toEqual([['FLUX-1'], ['FLUX-2']]);
  });
});

// FLUX-1396 (Group E): watchdog / stoker integration. `runWatchdog`, `reconcileTicket`, and `feedCoal`
// are internal (unexported) — the only exported seam that drives all three together is `stokerTick`, so
// these tests spin up the REAL furnace-store + task-store (mirroring furnace-integration.test.ts's
// established pattern: a tmpdir workspace root, mocked only at the two external edges — the agent-session
// spawn `fetch` and `postPrReview`, already mocked file-wide above) rather than hand-rolling an in-memory
// fake of the store.
describe('FLUX-1396 (Group E) — watchdog / stoker integration', () => {
  let root: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let sessCounter = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-e2e-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    await ensureFurnaceLoaded();
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    sessCounter = 0;

    // Stub the spawn route the Stoker calls to start an implementation/review session — register a
    // running session for (taskId, phase) and hand back its id, mirroring POST /cli-session/start for
    // real, minus an actual agent (same stub shape as furnace-integration.test.ts).
    fetchMock = vi.fn(async (url: unknown, init: { body: string }) => {
      const m = String(url).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/);
      if (!m || !m[1]) throw new Error(`unexpected fetch in FLUX-1396 watchdog/stoker tests: ${String(url)}`);
      const taskId = decodeURIComponent(m[1]);
      const id = `sess-${++sessCounter}`;
      const body = JSON.parse(init.body) as { phase: string };
      cliSessionsById.set(id, { id, taskId, status: 'running', phase: body.phase } as CliSessionRecord);
      registerSession(taskId, id);
      return { ok: true, json: async () => ({ session: { id } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Every ticketId a `/cli-session/start` call was made for. */
  function dispatchedTicketIds(): string[] {
    return fetchMock.mock.calls
      .map((c) => String(c[0]).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/))
      .filter((m: RegExpMatchArray | null): m is RegExpMatchArray => !!m)
      .map((m) => decodeURIComponent(m[1]!));
  }

  // Item 14: runWatchdog (furnace-stoker.ts ~line 1086-1104, re-verified above at ~1593) kills a session
  // that outlived its watchdog timeout and hard-fails the ticket — the per-session escape hatch for a
  // truly stuck agent that never reaches a terminal session status on its own.
  it('runWatchdog hard-fails a timed-out ticket: state -> failed, hard-fail, session stopped, currentSessionId cleared, consecutiveFailures bumped', async () => {
    const { id: ticketId } = await createTask({ title: 'Timed out', status: 'In Progress' });
    const batch = await createFurnaceBatch({
      title: 'watchdog', kind: 'parallel', tickets: [newBatchTicket(ticketId, 0)], sessionTimeoutMs: 45 * 60_000,
    });
    await mutateFurnaceBatch(batch.id, (b) => {
      b.status = 'burning';
      const t = b.tickets[0]!;
      t.state = 'implementing';
      t.currentSessionId = 'stuck-sess';
      t.sessionIds = ['stuck-sess'];
      t.sessionStartedAt = new Date(Date.now() - 60 * 60_000).toISOString(); // 60m ago > the 45m timeout
    });
    cliSessionsById.set('stuck-sess', { id: 'stuck-sess', taskId: ticketId, status: 'running', phase: 'implementation' } as CliSessionRecord);
    registerSession(ticketId, 'stuck-sess');
    const stopSpy = vi.spyOn(sessionStoreModule, 'stopAllSessionsForTask');

    await stokerTick(batch.id);

    const after = getFurnaceBatch(batch.id)!.tickets[0]!;
    expect(after.state).toBe('failed');
    expect(after.failureClass).toBe('hard-fail');
    expect(after.currentSessionId).toBeUndefined();
    expect(stopSpy).toHaveBeenCalledWith(ticketId, expect.any(String));
    expect(cliSessionsById.get('stuck-sess')?.status).toBe('cancelled');
    expect(getFurnaceBatch(batch.id)!.consecutiveFailures).toBe(1);
    stopSpy.mockRestore();
  });

  // FLUX-1397: an expired/invalid auth credential is a whole-BATCH problem — every ticket sharing the
  // CLI's credential fails identically, so the stoker halts the batch immediately (one re-auth-needed
  // signal) instead of letting each ticket independently park `hard-fail` and trip the generic breaker.
  it('an auth-expired session halts the WHOLE batch — every active sibling is parked with a re-auth reason, not just the ticket that hit it', async () => {
    const { id: authId } = await createTask({ title: 'Auth failed', status: 'In Progress' });
    const { id: siblingId } = await createTask({ title: 'Sibling still working', status: 'In Progress' });
    const batch = await createFurnaceBatch({
      title: 'shared-token', kind: 'parallel', burnRate: 2,
      tickets: [newBatchTicket(authId, 0), newBatchTicket(siblingId, 1)],
    });
    await mutateFurnaceBatch(batch.id, (b) => {
      b.status = 'burning';
      const a = b.tickets.find((t) => t.ticketId === authId)!;
      a.state = 'implementing';
      a.currentSessionId = 'auth-sess';
      a.sessionIds = ['auth-sess'];
      const s = b.tickets.find((t) => t.ticketId === siblingId)!;
      s.state = 'implementing';
      s.currentSessionId = 'sibling-sess';
      s.sessionIds = ['sibling-sess'];
    });
    cliSessionsById.set('auth-sess', { id: 'auth-sess', taskId: authId, status: 'failed', phase: 'implementation', terminalReason: 'auth-expired' } as CliSessionRecord);
    registerSession(authId, 'auth-sess');
    cliSessionsById.set('sibling-sess', { id: 'sibling-sess', taskId: siblingId, status: 'running', phase: 'implementation' } as CliSessionRecord);
    registerSession(siblingId, 'sibling-sess');

    await stokerTick(batch.id);

    const after = getFurnaceBatch(batch.id)!;
    expect(after.status).toBe('parked');
    expect(after.stopReason).toMatch(/claude login|refresh the api key/i);
    const authTicket = after.tickets.find((t) => t.ticketId === authId)!;
    const siblingTicket = after.tickets.find((t) => t.ticketId === siblingId)!;
    expect(authTicket.state).toBe('failed');
    expect(authTicket.failureClass).toBe('hard-fail');
    expect(authTicket.note).toMatch(/batch halted/);
    // The sibling never itself hit an auth error — it's parked by the HALT, not by an independent failure.
    expect(siblingTicket.state).toBe('failed');
    expect(siblingTicket.note).toMatch(/batch halted/);
    // A single failure, not N — the breaker counts each park, but the batch is ALREADY parked (short-circuited).
    expect(after.consecutiveFailures).toBeGreaterThan(0);
  });

  // Item 15: park-is-terminal — a ticket already `failed` must never be picked back up by a later tick.
  // `reconcileTicket` only ever visits `isActiveTicketState` tickets and `feedCoal` only ever starts
  // `queued` ones, so a `failed` ticket structurally falls outside both loops; this regression-locks that
  // invariant against the actual `stokerTick` entry point rather than trusting the state-filter reasoning
  // in isolation.
  it('a failed ticket is never resumed or redriven by a later tick (no-resume-after-timeout)', async () => {
    const { id: failedId } = await createTask({ title: 'Already failed', status: 'In Progress' });
    const { id: queuedId } = await createTask({ title: 'Sibling', status: 'Todo' });
    const batch = await createFurnaceBatch({
      title: 'no-resume', kind: 'parallel', burnRate: 2,
      tickets: [newBatchTicket(failedId, 0), newBatchTicket(queuedId, 1)],
    });
    await mutateFurnaceBatch(batch.id, (b) => {
      b.status = 'burning';
      const t = b.tickets.find((x) => x.ticketId === failedId)!;
      t.state = 'failed';
      t.failureClass = 'hard-fail';
      t.note = 'a prior watchdog timeout';
    });

    await stokerTick(batch.id);

    const failedTicket = getFurnaceBatch(batch.id)!.tickets.find((t) => t.ticketId === failedId)!;
    expect(failedTicket.state).toBe('failed'); // untouched — never resumed
    expect(failedTicket.currentSessionId).toBeUndefined();
    expect(dispatchedTicketIds()).not.toContain(failedId);
    // The still-queued sibling IS fed — confirms the tick actually ran and simply skipped the failed one.
    expect(dispatchedTicketIds()).toContain(queuedId);
  });

  describe('engine-restart-mid-stall (item 16)', () => {
    it('a rehydrated waiting-input session (no sessionHistoryEntry) on an implementing ticket parks needs-input', async () => {
      const { id: ticketId } = await createTask({ title: 'Restarted mid-wait', status: 'In Progress' });
      const batch = await createFurnaceBatch({ title: 'restart-wait', kind: 'parallel', tickets: [newBatchTicket(ticketId, 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'implementing';
        t.currentSessionId = 'rehydrated-sess';
        t.sessionIds = ['rehydrated-sess'];
      });
      // Simulate a session record rehydrated after an engine restart: the real `status` a restart can
      // reconstruct, but deliberately no `sessionHistoryEntry` (that durable "what happened" field is only
      // ever attached once something replays it) — decideTicketAction must still park correctly off
      // `status` alone rather than implicitly depending on that extra bookkeeping field.
      cliSessionsById.set('rehydrated-sess', { id: 'rehydrated-sess', taskId: ticketId, status: 'waiting-input', phase: 'implementation' } as CliSessionRecord);
      registerSession(ticketId, 'rehydrated-sess');

      await stokerTick(batch.id);

      const after = getFurnaceBatch(batch.id)!.tickets[0]!;
      expect(after.state).toBe('parked');
      expect(after.failureClass).toBe('needs-input');
    });

    it('a missing session (currentSessionId no longer resolvable, as after a restart wiped the in-memory session map) cold-redrives with a fresh spawn', async () => {
      const { id: ticketId } = await createTask({ title: 'Restarted, session gone', status: 'In Progress' });
      const batch = await createFurnaceBatch({ title: 'restart-cold', kind: 'parallel', tickets: [newBatchTicket(ticketId, 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'reviewing';
        t.currentSessionId = 'gone-sess'; // stale pointer — an engine restart clears cliSessionsById
        t.sessionIds = ['gone-sess'];
      });
      // Deliberately do NOT register 'gone-sess' in cliSessionsById/cliSessionsByTaskId: an engine restart
      // starts both maps empty, so the ticket's own bookkeeping is the only thing left remembering it.

      await stokerTick(batch.id);

      expect(dispatchedTicketIds()).toContain(ticketId);
      const after = getFurnaceBatch(batch.id)!.tickets[0]!;
      expect(after.state).toBe('reviewing'); // redrive keeps the same in-flight state, just a fresh session
      expect(after.currentSessionId).toBeTruthy();
      expect(after.currentSessionId).not.toBe('gone-sess'); // a brand-new session, not the stale one
    });
  });
});
