import { describe, it, expect } from 'vitest';
import type { Task } from '../types';
import type { BatchTicket, BatchTicketState } from '../furnaceTypes';
import { getMemberState, MEMBER_STATE_META, ACTIVE_MEMBER_STATES } from './memberState';
import { SESSION_STALE_MS } from '../orchestration';

const NOW = new Date('2026-07-18T05:00:00.000Z').getTime();

function makeTask(overrides: Partial<Task> & { id: string; status: string }): Task {
  return { title: overrides.id, ...overrides } as Task;
}

function makeBatchTicket(overrides: Partial<BatchTicket> & { state: BatchTicketState }): BatchTicket {
  return { ticketId: 'T-1', order: 0, attempts: 0, sessionIds: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Precedence table — one case per state, plus higher-precedence-wins cases.
// ---------------------------------------------------------------------------
describe('getMemberState precedence', () => {
  it('resolves tempering when task.tempering is true', () => {
    const task = makeTask({ id: 'T-1', status: 'In Progress', tempering: true });
    expect(getMemberState(task)).toBe('tempering');
  });

  it('resolves implementing from an active cliSession', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('implementing');
  });

  it('resolves parked from batchTicket.state === parked', () => {
    const task = makeTask({ id: 'T-1', status: 'In Progress' });
    const batchTicket = makeBatchTicket({ state: 'parked' });
    expect(getMemberState(task, batchTicket)).toBe('parked');
  });

  it('resolves parked from a gate-parked require-input swimlane (no batch data)', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Require Input',
      swimlane: 'require-input',
      history: [{ type: 'comment', comment: 'Parked by the Furnace: retry cap exhausted' }],
    } as unknown as Partial<Task> & { id: string; status: string });
    expect(getMemberState(task)).toBe('parked');
  });

  it('resolves failed from batchTicket.state === failed', () => {
    const task = makeTask({ id: 'T-1', status: 'In Progress' });
    const batchTicket = makeBatchTicket({ state: 'failed' });
    expect(getMemberState(task, batchTicket)).toBe('failed');
  });

  it('resolves done when board status is in the done set', () => {
    const task = makeTask({ id: 'T-1', status: 'Done' });
    expect(getMemberState(task)).toBe('done');
  });

  it('resolves ready when board status matches the ready status', () => {
    const task = makeTask({ id: 'T-1', status: 'Ready' });
    expect(getMemberState(task)).toBe('ready');
  });

  it('falls back to queued for everything else', () => {
    const task = makeTask({ id: 'T-1', status: 'Todo' });
    expect(getMemberState(task)).toBe('queued');
  });

  it('tempering beats implementing when both signals are present', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      tempering: true,
      cliSession: { status: 'running' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('tempering');
  });

  it('implementing beats parked when both signals are present', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running' } as Task['cliSession'],
    });
    const batchTicket = makeBatchTicket({ state: 'parked' });
    expect(getMemberState(task, batchTicket)).toBe('implementing');
  });

  it('parked beats failed when both signals are present', () => {
    // A batchTicket only ever carries one state, so simulate the combined signal via the
    // gate-parked swimlane (parked) alongside a done-elsewhere failed board status wouldn't
    // apply — use a stale batchTicket that says failed while the ticket is ALSO gate-parked.
    const task = makeTask({
      id: 'T-1',
      status: 'Require Input',
      swimlane: 'require-input',
      history: [{ type: 'comment', comment: 'Parked by the Furnace: retry cap exhausted' }],
    } as unknown as Partial<Task> & { id: string; status: string });
    const batchTicket = makeBatchTicket({ state: 'failed' });
    expect(getMemberState(task, batchTicket)).toBe('parked');
  });
});

// ---------------------------------------------------------------------------
// Batch-data-ABSENT degradation path — every state except `failed` must still resolve.
// ---------------------------------------------------------------------------
describe('getMemberState — batch data absent', () => {
  it('resolves tempering with no batchTicket arg', () => {
    expect(getMemberState(makeTask({ id: 'T-1', status: 'In Progress', tempering: true }))).toBe('tempering');
  });

  it('resolves implementing with no batchTicket arg', () => {
    expect(
      getMemberState(makeTask({ id: 'T-1', status: 'In Progress', cliSession: { status: 'pending' } as Task['cliSession'] })),
    ).toBe('implementing');
  });

  it('resolves parked with no batchTicket arg (gate-parked swimlane)', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Require Input',
      swimlane: 'require-input',
      history: [{ type: 'comment', comment: 'Parked by the Furnace: retry cap exhausted' }],
    } as unknown as Partial<Task> & { id: string; status: string });
    expect(getMemberState(task)).toBe('parked');
  });

  it('resolves done with no batchTicket arg', () => {
    expect(getMemberState(makeTask({ id: 'T-1', status: 'Released' }))).toBe('done');
  });

  it('resolves ready with no batchTicket arg', () => {
    expect(getMemberState(makeTask({ id: 'T-1', status: 'Ready' }))).toBe('ready');
  });

  it('resolves queued with no batchTicket arg', () => {
    expect(getMemberState(makeTask({ id: 'T-1', status: 'Todo' }))).toBe('queued');
  });

  it('never resolves failed without batch data — falls through to queued', () => {
    const task = makeTask({ id: 'T-1', status: 'Todo' });
    expect(getMemberState(task)).not.toBe('failed');
    expect(getMemberState(task)).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Stale / missing batch entry mid-session — must not throw, precedence still resolves.
// ---------------------------------------------------------------------------
describe('getMemberState — stale batch entry', () => {
  it('a stale batchTicket.state that disagrees with reality never overrides tempering', () => {
    const task = makeTask({ id: 'T-1', status: 'In Progress', tempering: true });
    const staleBatchTicket = makeBatchTicket({ state: 'queued' });
    expect(() => getMemberState(task, staleBatchTicket)).not.toThrow();
    expect(getMemberState(task, staleBatchTicket)).toBe('tempering');
  });

  it('a stale batchTicket.state === reimplementing (not queued/failed/parked) falls through to board status', () => {
    const task = makeTask({ id: 'T-1', status: 'Done' });
    const staleBatchTicket = makeBatchTicket({ state: 'reimplementing' });
    expect(getMemberState(task, staleBatchTicket)).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Optional doneStatuses/readyStatus params (config-aware done/ready sets).
// ---------------------------------------------------------------------------
describe('getMemberState — configurable done/ready sets', () => {
  it('honors a custom doneStatuses set', () => {
    const task = makeTask({ id: 'T-1', status: 'Shipped' });
    expect(getMemberState(task, undefined, { doneStatuses: new Set(['Shipped']) })).toBe('done');
  });

  it('honors a custom readyStatus', () => {
    const task = makeTask({ id: 'T-1', status: 'Review' });
    expect(getMemberState(task, undefined, { readyStatus: 'Review' })).toBe('ready');
  });
});

describe('MEMBER_STATE_META', () => {
  it('has an entry for every MemberState with the documented color vocabulary', () => {
    expect(MEMBER_STATE_META.done.color).toBe('#22c55e');
    expect(MEMBER_STATE_META.implementing.color).toBe('#8b5cf6');
    expect(MEMBER_STATE_META.parked.color).toBe('#f59e0b');
    expect(MEMBER_STATE_META.failed.color).toBe('#ef4444');
  });
});

// ---------------------------------------------------------------------------
// FLUX-1532: phase-aware live labels — a live session's `cliSession.phase` selects the state,
// not a single flattened `implementing` bucket.
// ---------------------------------------------------------------------------
describe('getMemberState — phase-aware live labels (FLUX-1532)', () => {
  it('labels a grooming-phase session as grooming', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Grooming',
      cliSession: { status: 'running', phase: 'grooming' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('grooming');
  });

  it('labels a review-phase session as reviewing', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Ready',
      cliSession: { status: 'running', phase: 'review' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('reviewing');
  });

  it('labels a finalize-phase session as finalizing', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Ready',
      cliSession: { status: 'running', phase: 'finalize' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('finalizing');
  });

  it('labels an implementation-phase session as implementing', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running', phase: 'implementation' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('implementing');
  });

  it('labels a fast-path-phase session as implementing', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Grooming',
      cliSession: { status: 'running', phase: 'fast-path' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('implementing');
  });

  it('FLUX-1383: labels a batch-grooming-phase session as grooming (writes no code, unlike fast-path)', () => {
    const task = makeTask({
      id: 'T-1',
      status: 'Grooming',
      cliSession: { status: 'running', phase: 'batch-grooming' } as Task['cliSession'],
    });
    expect(getMemberState(task)).toBe('grooming');
  });

  it('falls back to implementing for a chat-phase or absent-phase session', () => {
    const chatTask = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running', phase: 'chat' } as Task['cliSession'],
    });
    expect(getMemberState(chatTask)).toBe('implementing');

    const noPhaseTask = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running' } as Task['cliSession'],
    });
    expect(getMemberState(noPhaseTask)).toBe('implementing');
  });

  it('ACTIVE_MEMBER_STATES contains exactly the four phase-labeled live states', () => {
    expect([...ACTIVE_MEMBER_STATES].sort()).toEqual(['finalizing', 'grooming', 'implementing', 'reviewing'].sort());
  });
});

// ---------------------------------------------------------------------------
// FLUX-1532: staleness — a live session with no recent output demotes to `stalled` instead of
// reading as actively working forever.
// ---------------------------------------------------------------------------
describe('getMemberState — staleness (FLUX-1532)', () => {
  it('resolves stalled when a running session has produced no output past SESSION_STALE_MS', () => {
    const staleLastOutput = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running', phase: 'implementation', lastOutputAt: staleLastOutput } as Task['cliSession'],
    });
    expect(getMemberState(task, undefined, { nowMs: NOW })).toBe('stalled');
  });

  it('resolves the phase label (not stalled) when output is recent', () => {
    const recentLastOutput = new Date(NOW - 60_000).toISOString();
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running', phase: 'grooming', lastOutputAt: recentLastOutput } as Task['cliSession'],
    });
    expect(getMemberState(task, undefined, { nowMs: NOW })).toBe('grooming');
  });

  it('resolves stalled for a non-resumable waiting-input session regardless of lastOutputAt age', () => {
    const recentLastOutput = new Date(NOW - 1_000).toISOString();
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'waiting-input', resumable: false, lastOutputAt: recentLastOutput } as Task['cliSession'],
    });
    expect(getMemberState(task, undefined, { nowMs: NOW })).toBe('stalled');
  });

  it('never resolves stalled for a scheduled session even with a very old lastOutputAt (FLUX-1390)', () => {
    const veryOldLastOutput = new Date(NOW - SESSION_STALE_MS * 10).toISOString();
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'scheduled', lastOutputAt: veryOldLastOutput } as Task['cliSession'],
    });
    // 'scheduled' isn't in the live-session status set this selector checks, so it falls through
    // to board status ('In Progress' → queued) rather than resolving 'stalled' or any phase label.
    expect(getMemberState(task, undefined, { nowMs: NOW })).toBe('queued');
  });

  it('tempering beats stalled when both signals are present', () => {
    const staleLastOutput = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      tempering: true,
      cliSession: { status: 'running', lastOutputAt: staleLastOutput } as Task['cliSession'],
    });
    expect(getMemberState(task, undefined, { nowMs: NOW })).toBe('tempering');
  });

  it('stalled beats parked/failed when both signals are present', () => {
    const staleLastOutput = new Date(NOW - SESSION_STALE_MS - 1_000).toISOString();
    const task = makeTask({
      id: 'T-1',
      status: 'In Progress',
      cliSession: { status: 'running', lastOutputAt: staleLastOutput } as Task['cliSession'],
    });
    const batchTicket = makeBatchTicket({ state: 'parked' });
    expect(getMemberState(task, batchTicket, { nowMs: NOW })).toBe('stalled');
  });
});
