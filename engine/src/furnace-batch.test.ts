// The Furnace — batch model + decision core + slot math (FLUX-1053).
//
// Focused unit tests for the redesigned batch architecture. The run/magazine/group tests were removed
// with that architecture; this covers the pure, high-value surfaces: the per-ticket decision core, the
// two batch kinds, worktree-slot math, and the burn report.

import { describe, it, expect } from 'vitest';
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
} from './furnace-stoker.js';

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
  it('review with no verdict parks', () => {
    const a = decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'completed', reviewState: null, retryCap: 2 });
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
    expect(decideTicketAction({ ticket: mkTicket({ state: 'reviewing' }), sessionStatus: 'completed', reviewState: null, retryCap: 2 }))
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
