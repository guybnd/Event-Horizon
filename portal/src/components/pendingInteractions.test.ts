import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isGateParkedTicket, isPlanApprovalPending, isPlanApprovalNeedsYou, isPlanGateRevising, planReviewFeedback, planTldr, revisePlan, dismissPlanReview } from './pendingInteractions';
import { updateTask, startPlanRevise } from '../api';
import type { Config, Task } from '../types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    updateTask: vi.fn().mockResolvedValue({}),
    startPlanRevise: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  };
});

const mockedUpdateTask = vi.mocked(updateTask);
const mockedStartPlanRevise = vi.mocked(startPlanRevise);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'FLUX-1',
    status: 'Grooming',
    ...overrides,
  } as Task;
}

describe('isGateParkedTicket (FLUX-1262)', () => {
  it('is false for a ticket not in the require-input swimlane', () => {
    expect(isGateParkedTicket(makeTask({ swimlane: null }))).toBe(false);
  });

  it('is false for a genuine human-facing require-input question', () => {
    const task = makeTask({
      swimlane: 'require-input',
      history: [{ type: 'swimlane_change', action: 'set', swimlane: 'require-input', user: 'Agent', comment: 'Which API should I target?', date: '2026-07-01T00:00:00.000Z' }],
    });
    expect(isGateParkedTicket(task)).toBe(false);
  });

  it('is true when Furnace/Temper parked the ticket (machine-authored comment prefix)', () => {
    const task = makeTask({
      swimlane: 'require-input',
      history: [{ type: 'comment', user: 'Furnace', comment: 'Parked by the Furnace: Temper: review still requesting changes after 2 re-implementation attempt(s). Needs your input before this ticket can continue.', date: '2026-07-01T00:00:00.000Z' }],
    });
    expect(isGateParkedTicket(task)).toBe(true);
  });

  it('reads the pre-computed historyDigest.requireInput when present (list payload)', () => {
    const task = makeTask({
      swimlane: 'require-input',
      historyDigest: {
        length: 1, lastEntry: null, lastActivityAt: '', enteredCurrentStatusAt: null, isSpeedDemon: false,
        statusChanges24h: [], comments: [],
        requireInput: { question: 'Parked by the Furnace: could not start a review session after 6 attempts (the environment may be broken).', setDate: '2026-07-01T00:00:00.000Z' },
        planReviewComment: null,
      },
    });
    expect(isGateParkedTicket(task)).toBe(true);
  });
});

describe('isPlanApprovalPending (FLUX-1262 / FLUX-1296)', () => {
  const autoThenYouConfig: Config = { gatePolicy: { boardDefault: { plan: 'auto-then-you', review: 'you' } } } as Config;
  const youConfig: Config = { gatePolicy: { boardDefault: { plan: 'you', review: 'you' } } } as Config;
  const autoConfig: Config = { gatePolicy: { boardDefault: { plan: 'auto', review: 'you' } } } as Config;

  it('is false when planReviewState is unset', () => {
    expect(isPlanApprovalPending(makeTask({ status: 'Grooming' }), autoThenYouConfig)).toBe(false);
  });

  it('is false outside Grooming even with a verdict set', () => {
    const task = makeTask({ status: 'Todo', planReviewState: 'approved' });
    expect(isPlanApprovalPending(task, autoThenYouConfig)).toBe(false);
  });

  it('is true when Grooming + a verdict is set, regardless of the resolved plan gate value (FLUX-1296: extended beyond auto-then-you)', () => {
    const task = makeTask({ status: 'Grooming', planReviewState: 'approved' });
    expect(isPlanApprovalPending(task, autoThenYouConfig)).toBe(true);
    expect(isPlanApprovalPending(task, youConfig)).toBe(true);
    expect(isPlanApprovalPending(task, autoConfig)).toBe(true);
  });

  it('is true when Grooming + a verdict is set + the board default plan gate is auto-then-you', () => {
    const task = makeTask({ status: 'Grooming', planReviewState: 'changes-requested' });
    expect(isPlanApprovalPending(task, autoThenYouConfig)).toBe(true);
  });

  it('a per-ticket gate override does not affect it either — only status + verdict matter now', () => {
    const task = makeTask({ status: 'Grooming', planReviewState: 'approved', gatePolicyOverride: { plan: 'auto-then-you' } });
    expect(isPlanApprovalPending(task, youConfig)).toBe(true);
  });
});

describe('isPlanGateRevising (FLUX-1319)', () => {
  it('is true only for planGateRunning + changes-requested (mid auto-revise)', () => {
    expect(isPlanGateRevising(makeTask({ planGateRunning: true, planReviewState: 'changes-requested' }))).toBe(true);
  });

  it('is FALSE for an approved verdict even while planGateRunning lingers during cleanup', () => {
    // The reported bug: approved recorded, but the gate hasn't cleared planGateRunning yet on its
    // next tick. The plan is finished + actionable — it must NOT read as "revising".
    expect(isPlanGateRevising(makeTask({ planGateRunning: true, planReviewState: 'approved' }))).toBe(false);
  });

  it('is false when the gate is not running', () => {
    expect(isPlanGateRevising(makeTask({ planReviewState: 'changes-requested' }))).toBe(false);
  });
});

describe('isPlanApprovalNeedsYou (FLUX-1319)', () => {
  const autoThenYouConfig: Config = { gatePolicy: { boardDefault: { plan: 'auto-then-you', review: 'you' } } } as Config;

  it('excludes a ticket the gate loop is actively revising (changes-requested + planGateRunning)', () => {
    const revising = makeTask({ status: 'Grooming', planReviewState: 'changes-requested', planGateRunning: true });
    expect(isPlanApprovalPending(revising, autoThenYouConfig)).toBe(true); // still "pending" for the in-chat card…
    expect(isPlanApprovalNeedsYou(revising, autoThenYouConfig)).toBe(false); // …but NOT in the Needs-You inbox
  });

  it('INCLUDES an approved plan even while planGateRunning lingers during cleanup (the reported bug)', () => {
    const approvedCleaningUp = makeTask({ status: 'Grooming', planReviewState: 'approved', planGateRunning: true });
    expect(isPlanApprovalNeedsYou(approvedCleaningUp, autoThenYouConfig)).toBe(true);
  });

  it('includes a ticket whose loop has fully stopped and awaits a human confirm', () => {
    const stopped = makeTask({ status: 'Grooming', planReviewState: 'approved' });
    expect(isPlanApprovalNeedsYou(stopped, autoThenYouConfig)).toBe(true);
  });

  it('FLUX-1296: also includes a `you`-gate ticket after its manual one-pass review — same shape as auto-then-you', () => {
    const youConfig: Config = { gatePolicy: { boardDefault: { plan: 'you', review: 'you' } } } as Config;
    const task = makeTask({ status: 'Grooming', planReviewState: 'changes-requested' });
    expect(isPlanApprovalNeedsYou(task, youConfig)).toBe(true);
  });
});

describe('planReviewFeedback (FLUX-1289)', () => {
  it('reads the pre-computed historyDigest.planReviewComment when present (list payload)', () => {
    const task = makeTask({
      historyDigest: {
        length: 1, lastEntry: null, lastActivityAt: '', enteredCurrentStatusAt: null, isSpeedDemon: false,
        statusChanges24h: [], comments: [], requireInput: null,
        planReviewComment: { text: 'CHANGES NEEDED: fix the anchor.', date: '2026-07-08T00:00:00.000Z' },
      },
    });
    expect(planReviewFeedback(task)).toEqual({ text: 'CHANGES NEEDED: fix the anchor.', date: '2026-07-08T00:00:00.000Z' });
  });

  it('falls back to scanning full history for a DETAIL task with no digest — attributed (FLUX-1303)', () => {
    const task = makeTask({
      history: [{ type: 'comment', user: 'Plan Gate', comment: 'CHANGES NEEDED: fix the anchor.', date: '2026-07-08T00:00:00.000Z' }],
    });
    expect(planReviewFeedback(task)).toEqual({ text: 'CHANGES NEEDED: fix the anchor.', date: '2026-07-08T00:00:00.000Z', user: 'Plan Gate' });
  });

  it('returns null when neither a digest nor a history comment exists', () => {
    expect(planReviewFeedback(makeTask())).toBeNull();
  });
});

describe('planTldr (FLUX-1303)', () => {
  it('extracts the leading TL;DR blockquote, stripped of markdown', () => {
    expect(planTldr('> **TL;DR** — Make the `blockquote` renderer bigger.\n\n## Problem\n…'))
      .toBe('Make the blockquote renderer bigger.');
  });

  it('tolerates a plain unbolded TLDR prefix and returns null when absent', () => {
    expect(planTldr('> TLDR: short version.')).toBe('short version.');
    expect(planTldr('## Problem\nNo summary here.')).toBeNull();
    expect(planTldr(undefined)).toBeNull();
  });
});

describe('revisePlan (FLUX-1303 — atomic "Send for re-grooming")', () => {
  beforeEach(() => {
    mockedUpdateTask.mockClear();
    mockedStartPlanRevise.mockClear().mockResolvedValue({ ok: true, message: 'ok' });
  });

  it('makes ONE atomic engine call carrying the user + trimmed notes (no follow-up PUT to race/fail)', async () => {
    await revisePlan('FLUX-1', 'Guy', '  fix the color  ');
    expect(mockedStartPlanRevise).toHaveBeenCalledWith('FLUX-1', { notes: 'fix the color', user: 'Guy' });
    expect(mockedUpdateTask).not.toHaveBeenCalled();
  });

  it('omits empty notes and propagates engine failures to the caller (surfaced, never swallowed)', async () => {
    await revisePlan('FLUX-1', 'Guy', '   ');
    expect(mockedStartPlanRevise).toHaveBeenCalledWith('FLUX-1', { user: 'Guy' });
    mockedStartPlanRevise.mockRejectedValueOnce(new Error('engine down'));
    await expect(revisePlan('FLUX-1', 'Guy')).rejects.toThrow('engine down');
  });
});

describe('dismissPlanReview (FLUX-1289/FLUX-1303 — the single "Set aside")', () => {
  beforeEach(() => {
    mockedUpdateTask.mockClear();
    mockedStartPlanRevise.mockClear();
  });

  it('clears the verdict + reviewed-body hash with NO session dispatch (distinct from revisePlan)', async () => {
    await dismissPlanReview('FLUX-1', 'Guy');
    expect(mockedStartPlanRevise).not.toHaveBeenCalled();
    expect(mockedUpdateTask).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({ planReviewState: null, planReviewBodyHash: null, updatedBy: 'Guy' }));
  });
});
