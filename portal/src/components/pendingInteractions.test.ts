import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isGateParkedTicket, isPlanApprovalPending, isPlanApprovalNeedsYou, isPlanGateRevising, isPlanGateInFlight, canApprovePlan, planReviewFeedback, planTldr, revisePlan, dismissPlanReview, dispatchApprovedImplementation, approvePlanAndStart } from './pendingInteractions';
import { updateTask, startPlanRevise, createBranch } from '../api';
import { launchPhaseDefault } from '../agentActions';
import type { Config, Task, CliSessionSummary } from '../types';
import type { NotifyApi } from '../hooks/useNotify';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    updateTask: vi.fn().mockResolvedValue({}),
    startPlanRevise: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    createBranch: vi.fn().mockResolvedValue({ branch: 'flux/x' }),
  };
});

vi.mock('../agentActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agentActions')>();
  return {
    ...actual,
    launchPhaseDefault: vi.fn().mockResolvedValue({ id: 'sess-1' }),
  };
});

const mockedUpdateTask = vi.mocked(updateTask);
const mockedStartPlanRevise = vi.mocked(startPlanRevise);
const mockedCreateBranch = vi.mocked(createBranch);
const mockedLaunchPhaseDefault = vi.mocked(launchPhaseDefault);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'FLUX-1',
    status: 'Grooming',
    ...overrides,
  } as Task;
}

function makeSession(overrides: Partial<CliSessionSummary> = {}): CliSessionSummary {
  return { id: 'sess-0', taskId: 'FLUX-1', framework: 'claude', status: 'running', command: 'x', ...overrides } as CliSessionSummary;
}

function makeNotify(): NotifyApi {
  return { success: vi.fn(), error: vi.fn(), info: vi.fn() };
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

describe('canApprovePlan (FLUX-1339 — standing Approve, decoupled from the verdict)', () => {
  it('is true for a Grooming ticket with a plan body but NO verdict (the iterated-in-chat case)', () => {
    const task = makeTask({ status: 'Grooming', body: '## Implementation plan\n\nDo the thing.' });
    expect(task.planReviewState).toBeUndefined();
    expect(canApprovePlan(task)).toBe(true);
  });

  it('stays true regardless of the verdict — approved or changes-requested both approvable', () => {
    expect(canApprovePlan(makeTask({ status: 'Grooming', body: 'plan', planReviewState: 'approved' }))).toBe(true);
    expect(canApprovePlan(makeTask({ status: 'Grooming', body: 'plan', planReviewState: 'changes-requested' }))).toBe(true);
  });

  it('is false when the plan body is empty or whitespace-only', () => {
    expect(canApprovePlan(makeTask({ status: 'Grooming', body: '' }))).toBe(false);
    expect(canApprovePlan(makeTask({ status: 'Grooming', body: '   \n  ' }))).toBe(false);
    expect(canApprovePlan(makeTask({ status: 'Grooming' }))).toBe(false);
  });

  it('is false outside Grooming even with a plan body', () => {
    expect(canApprovePlan(makeTask({ status: 'Todo', body: 'plan' }))).toBe(false);
    expect(canApprovePlan(makeTask({ status: 'In Progress', body: 'plan' }))).toBe(false);
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

describe('isPlanGateInFlight (FLUX-1585)', () => {
  it('is true for an ACTIVE run (planGateRunning), regardless of verdict', () => {
    expect(isPlanGateInFlight(makeTask({ status: 'Grooming', planGateRunning: true, planReviewState: 'changes-requested' }))).toBe(true);
    expect(isPlanGateInFlight(makeTask({ status: 'Grooming', planGateRunning: true, planReviewState: null }))).toBe(true);
  });

  it('is true for the PARKED wedge — planGateRunning cleared, but the verdict is still changes-requested in Grooming', () => {
    // The FLUX-1560 repro shape: `stopGateRun` deleted the registry entry and `planGateRunning`, but
    // the changes-requested verdict from the last review pass is still on the ticket.
    expect(isPlanGateInFlight(makeTask({ status: 'Grooming', planGateRunning: undefined, planReviewState: 'changes-requested' }))).toBe(true);
  });

  it('is false for an approved verdict with no active run — nothing to protect from a chat resume', () => {
    expect(isPlanGateInFlight(makeTask({ status: 'Grooming', planReviewState: 'approved' }))).toBe(false);
  });

  it('is false outside Grooming even with a stale changes-requested verdict', () => {
    expect(isPlanGateInFlight(makeTask({ status: 'Todo', planReviewState: 'changes-requested' }))).toBe(false);
  });

  it('is false for a plain Grooming ticket with no gate activity at all', () => {
    expect(isPlanGateInFlight(makeTask({ status: 'Grooming' }))).toBe(false);
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

describe('dispatchApprovedImplementation (FLUX-1294/FLUX-1369 — shared "Approve & start" dispatch)', () => {
  const config: Config = { worktreeByDefault: true, defaultFramework: 'claude' } as Config;

  beforeEach(() => {
    mockedCreateBranch.mockClear().mockResolvedValue({ branch: 'flux/x' });
    mockedLaunchPhaseDefault.mockClear().mockResolvedValue(makeSession());
  });

  it('skips createBranch for XS effort, but still launches the implementation session', async () => {
    const task = makeTask({ effort: 'XS' });
    const notify = makeNotify();
    await dispatchApprovedImplementation(task, config, 'Guy', notify);
    expect(mockedCreateBranch).not.toHaveBeenCalled();
    expect(mockedLaunchPhaseDefault).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'FLUX-1', phase: 'implementation', currentUser: 'Guy' }),
    );
    expect(notify.info).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('creates a branch for non-XS effort with worktree per config.worktreeByDefault', async () => {
    const task = makeTask({ effort: 'M' });
    await dispatchApprovedImplementation(task, config, 'Guy', makeNotify());
    expect(mockedCreateBranch).toHaveBeenCalledWith('FLUX-1', { worktree: true });
  });

  it('passes worktree: false when config.worktreeByDefault is unset/false', async () => {
    const task = makeTask({ effort: 'M' });
    await dispatchApprovedImplementation(task, { ...config, worktreeByDefault: false }, 'Guy', makeNotify());
    expect(mockedCreateBranch).toHaveBeenCalledWith('FLUX-1', { worktree: false });
  });

  it('active-session guard: early-returns with notify.info and never dispatches', async () => {
    const task = makeTask({ effort: 'M', cliSession: makeSession({ status: 'running' }) });
    const notify = makeNotify();
    await dispatchApprovedImplementation(task, config, 'Guy', notify);
    expect(mockedCreateBranch).not.toHaveBeenCalled();
    expect(mockedLaunchPhaseDefault).not.toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining('a session is already running'));
  });

  it('dispatches when the existing session is terminal (not an active guard)', async () => {
    const task = makeTask({ effort: 'XS', cliSession: makeSession({ status: 'completed', endedAt: '2026-07-01T00:00:00.000Z' }) });
    await dispatchApprovedImplementation(task, config, 'Guy', makeNotify());
    expect(mockedLaunchPhaseDefault).toHaveBeenCalled();
  });

  it('launchPhaseDefault returning falsy → notify.info "no default implementation persona" (does not throw)', async () => {
    mockedLaunchPhaseDefault.mockResolvedValueOnce(null);
    const task = makeTask({ effort: 'XS' });
    const notify = makeNotify();
    await expect(dispatchApprovedImplementation(task, config, 'Guy', notify)).resolves.toBeUndefined();
    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining('no default implementation persona'));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('a thrown dispatch error surfaces via notify.error and is never rethrown', async () => {
    mockedLaunchPhaseDefault.mockRejectedValueOnce(new Error('engine down'));
    const task = makeTask({ effort: 'XS' });
    const notify = makeNotify();
    await expect(dispatchApprovedImplementation(task, config, 'Guy', notify)).resolves.toBeUndefined();
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('engine down'));
  });

  it('a thrown createBranch error also surfaces via notify.error without reaching launchPhaseDefault', async () => {
    mockedCreateBranch.mockRejectedValueOnce(new Error('branch exists'));
    const task = makeTask({ effort: 'M' });
    const notify = makeNotify();
    await dispatchApprovedImplementation(task, config, 'Guy', notify);
    expect(mockedLaunchPhaseDefault).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('branch exists'));
  });

  it('passes a default focusComment, overridable by the caller', async () => {
    const task = makeTask({ effort: 'XS' });
    await dispatchApprovedImplementation(task, config, 'Guy', makeNotify());
    expect(mockedLaunchPhaseDefault).toHaveBeenCalledWith(expect.objectContaining({ focusComment: 'Plan approved via "Approve & start."' }));

    mockedLaunchPhaseDefault.mockClear();
    await dispatchApprovedImplementation(task, config, 'Guy', makeNotify(), 'custom note');
    expect(mockedLaunchPhaseDefault).toHaveBeenCalledWith(expect.objectContaining({ focusComment: 'custom note' }));
  });
});

describe('approvePlanAndStart (FLUX-1369 — commit then dispatch)', () => {
  beforeEach(() => {
    mockedUpdateTask.mockClear();
    mockedCreateBranch.mockClear().mockResolvedValue({ branch: 'flux/x' });
    mockedLaunchPhaseDefault.mockClear().mockResolvedValue(makeSession());
  });

  it('commits the approve->Todo update via updateTask, then dispatches using the RETURNED (updated) task', async () => {
    const task = makeTask({ status: 'Grooming', effort: 'XS' });
    const updated = makeTask({ status: 'Todo', effort: 'XS', cliSession: undefined });
    mockedUpdateTask.mockResolvedValueOnce(updated);
    const config: Config = { columns: [{ name: 'Todo' }] } as Config;

    await approvePlanAndStart(task, config, 'Guy', makeNotify());

    expect(mockedUpdateTask).toHaveBeenCalledWith(
      'FLUX-1',
      expect.objectContaining({ status: 'Todo', planReviewState: null, planReviewBodyHash: null, updatedBy: 'Guy' }),
    );
    // XS effort on the updated task → no branch created, but the session still launches.
    expect(mockedCreateBranch).not.toHaveBeenCalled();
    expect(mockedLaunchPhaseDefault).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'FLUX-1' }));
  });

  it('does not dispatch when the returned task already carries an active session', async () => {
    const task = makeTask({ status: 'Grooming', effort: 'M' });
    const updated = makeTask({ status: 'Todo', effort: 'M', cliSession: makeSession({ status: 'pending' }) });
    mockedUpdateTask.mockResolvedValueOnce(updated);
    const notify = makeNotify();

    await approvePlanAndStart(task, {} as Config, 'Guy', notify);

    expect(mockedCreateBranch).not.toHaveBeenCalled();
    expect(mockedLaunchPhaseDefault).not.toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining('a session is already running'));
  });
});
