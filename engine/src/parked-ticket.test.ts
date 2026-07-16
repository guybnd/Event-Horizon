import { describe, it, expect } from 'vitest';
import { isDelegatedMember, isParked, leadUnarmedWaitMessage, narratesUnarmedWaitPromise, type ParkedSnapshot } from './parked-ticket.js';
import type { CliSessionRecord } from './agents/types.js';

// FLUX-651 — the "agent sat on its hands" decision. Pure logic; the I/O wrapper (flagIfParked)
// is exercised end-to-end by the session lifecycle.

const base: ParkedSnapshot = {
  status: 'In Progress',
  statusAtTurnStart: 'In Progress',
  swimlane: null,
  subtaskCount: 0,
  subtaskCountAtTurnStart: 0,
  requireInputStatus: 'Require Input',
  isDelegated: false,
};

describe('isParked', () => {
  it('flags an In Progress turn that ends with no action taken', () => {
    expect(isParked(base)).toBe(true);
  });

  it('flags a Grooming turn that ends with no action taken', () => {
    expect(isParked({ ...base, status: 'Grooming', statusAtTurnStart: 'Grooming' })).toBe(true);
  });

  it('does NOT flag when the agent moved the status (e.g. → Ready)', () => {
    expect(isParked({ ...base, status: 'Ready' })).toBe(false); // Ready isn't a working status anyway
    expect(isParked({ ...base, status: 'Todo', statusAtTurnStart: 'Grooming' })).toBe(false); // groomed → Todo
  });

  it('does NOT flag when the agent raised Require Input (swimlane)', () => {
    expect(isParked({ ...base, swimlane: 'require-input' })).toBe(false);
  });

  it('does NOT flag when the status itself is the Require Input status', () => {
    expect(isParked({ ...base, status: 'Require Input' })).toBe(false);
  });

  it('does NOT flag when the agent created a subtask this turn', () => {
    expect(isParked({ ...base, subtaskCount: 1, subtaskCountAtTurnStart: 0 })).toBe(false);
  });

  it('does NOT flag resting statuses with no new comment (Todo / Ready / Done / Backlog)', () => {
    for (const status of ['Todo', 'Ready', 'Done', 'Backlog']) {
      expect(isParked({ ...base, status, statusAtTurnStart: status })).toBe(false);
    }
  });

  // FLUX-826 — SOFT backstop for resting/terminal statuses: a new agent comment with no board
  // action (and not routed through ask_user_question) is a "left an open item" nudge.
  describe('FLUX-826 resting-status soft backstop', () => {
    const resting: ParkedSnapshot = {
      ...base,
      status: 'Done',
      statusAtTurnStart: 'Done',
      commentCount: 0,
      commentCountAtTurnStart: 0,
    };

    it('flags a Done ticket left with a NEW agent comment and no board action', () => {
      expect(isParked({ ...resting, commentCount: 1, commentCountAtTurnStart: 0 })).toBe(true);
    });

    it('flags across every resting/terminal status', () => {
      for (const status of ['Todo', 'Ready', 'Done', 'Backlog', 'Released', 'Archived']) {
        expect(isParked({ ...resting, status, statusAtTurnStart: status, commentCount: 2, commentCountAtTurnStart: 1 })).toBe(true);
      }
    });

    it('does NOT flag when no new comment was added this turn', () => {
      expect(isParked({ ...resting, commentCount: 3, commentCountAtTurnStart: 3 })).toBe(false);
    });

    it('does NOT flag when the agent routed the decision through ask_user_question this turn', () => {
      expect(isParked({ ...resting, commentCount: 1, commentCountAtTurnStart: 0, askedThisTurn: true })).toBe(false);
    });

    it('does NOT flag when the agent took a board action alongside the comment (status moved)', () => {
      expect(isParked({ ...resting, status: 'Done', statusAtTurnStart: 'Ready', commentCount: 1, commentCountAtTurnStart: 0 })).toBe(false);
    });

    it('does NOT flag when the agent created a subtask alongside the comment', () => {
      expect(isParked({ ...resting, commentCount: 1, commentCountAtTurnStart: 0, subtaskCount: 1, subtaskCountAtTurnStart: 0 })).toBe(false);
    });

    it('does NOT flag a delegated member even with a fresh comment', () => {
      expect(isParked({ ...resting, commentCount: 1, commentCountAtTurnStart: 0, isDelegated: true })).toBe(false);
    });

    it('treats missing comment counts as "no new comment" (no false nudge)', () => {
      expect(isParked({ ...base, status: 'Done', statusAtTurnStart: 'Done' })).toBe(false);
    });
  });

  it('does NOT flag delegated / scatter-gather members (orchestrator owns the transition)', () => {
    expect(isParked({ ...base, isDelegated: true })).toBe(false);
  });

  // FLUX-1320: a needsAction flag standing at turn end was raised THIS turn by a more specific path
  // (the plan gate's eager verdict stop, an ask_user_question timeout) — the flag is cleared at every
  // turn start, so the generic backstop must defer to it rather than refresh the deduped notification
  // with its generic message.
  it('does NOT flag when a needsAction flag is already standing at turn end (working status)', () => {
    expect(isParked({ ...base, needsActionSet: true })).toBe(false);
    expect(isParked({ ...base, status: 'Grooming', statusAtTurnStart: 'Grooming', needsActionSet: true })).toBe(false);
  });

  it('does NOT soft-flag a resting status with a fresh comment when needsAction already stands', () => {
    expect(isParked({ ...base, status: 'Done', statusAtTurnStart: 'Done', commentCount: 1, commentCountAtTurnStart: 0, needsActionSet: true })).toBe(false);
  });

  it('flags regardless of branchless vs branched (the decision does not look at the branch)', () => {
    // Same inputs reach isParked the same way whether or not the ticket has a branch.
    expect(isParked(base)).toBe(true);
  });

  it('handles a missing turn-start snapshot conservatively (no false "changed")', () => {
    expect(isParked({ ...base, statusAtTurnStart: undefined })).toBe(true);
  });
});

// FLUX-1436 (FLUX-651 coverage hole) — the blanket `groupId` exemption also exempted group LEADS (supervisor
// orchestrator / scatter-gather combiner), so an orchestrator that parked went entirely unflagged:
// it owns the transition, and nobody else was left to drive the ticket. Real incident: a supervisor
// dev-lead fanned out 11 workers, ended its turn "Continuing to wait for the stabilization signal"
// with nothing armed, and the ticket sat In Progress silently.
describe('isDelegatedMember', () => {
  const session = (o: Partial<CliSessionRecord>): CliSessionRecord => o as CliSessionRecord;

  it('exempts scatter-gather workers (step position), with or without a groupId', () => {
    expect(isDelegatedMember(session({ groupId: 'g1', patternPosition: 'step' }))).toBe(true);
    expect(isDelegatedMember(session({ patternPosition: 'step' }))).toBe(true);
  });

  it('exempts non-lead group members (supervisor delegates / position-less members)', () => {
    expect(isDelegatedMember(session({ groupId: 'g1', patternPosition: 'assistant' }))).toBe(true);
    expect(isDelegatedMember(session({ groupId: 'g1' }))).toBe(true);
  });

  it('does NOT exempt a group LEAD — the lead IS the orchestrator that owns the transition', () => {
    expect(isDelegatedMember(session({ groupId: 'g1', patternPosition: 'lead' }))).toBe(false);
  });

  it('does NOT exempt a standalone session', () => {
    expect(isDelegatedMember(session({}))).toBe(false);
    expect(isDelegatedMember(session({ patternPosition: 'standalone' }))).toBe(false);
  });
});

// FLUX-1432 — the "chat session promised an unarmed wait" backstop. Pure logic; the I/O wrapper
// (flagIfUnarmedWaitPromise) is exercised end-to-end by the session lifecycle, same split as
// isParked/flagIfParked above.
describe('narratesUnarmedWaitPromise', () => {
  it('flags the real FLUX-1428 incident phrasing', () => {
    expect(narratesUnarmedWaitPromise(
      "I'll pause here and wait for the background copy to finish before running the tests.",
    )).toBe(true);
  });

  it('flags common promise-to-resume phrasings', () => {
    expect(narratesUnarmedWaitPromise("I'll wait for the build to finish, then run the tests.")).toBe(true);
    expect(narratesUnarmedWaitPromise('I will wait for CI before merging.')).toBe(true);
    expect(narratesUnarmedWaitPromise('Let me wait for the deployment to complete.')).toBe(true);
    expect(narratesUnarmedWaitPromise("I'm going to hold off until the migration lands.")).toBe(true);
    expect(narratesUnarmedWaitPromise("I'll check back once the job finishes.")).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(narratesUnarmedWaitPromise("I'LL WAIT for the build to finish.")).toBe(true);
  });

  it('does NOT flag ordinary progress narration with no wait promise', () => {
    expect(narratesUnarmedWaitPromise("I'll now run the tests.")).toBe(false);
    expect(narratesUnarmedWaitPromise('Moved the ticket to Ready — implementation complete.')).toBe(false);
    expect(narratesUnarmedWaitPromise('Tests are passing; no further action needed.')).toBe(false);
  });

  it('handles missing/empty text without throwing', () => {
    expect(narratesUnarmedWaitPromise(undefined)).toBe(false);
    expect(narratesUnarmedWaitPromise(null)).toBe(false);
    expect(narratesUnarmedWaitPromise('')).toBe(false);
  });

  it('flags the supervisor-lead incident phrasing ("continuing to wait")', () => {
    expect(narratesUnarmedWaitPromise('Continuing to wait for the stabilization signal from the workers.')).toBe(true);
    expect(narratesUnarmedWaitPromise('I will continue to wait for the fan-out to settle.')).toBe(true);
  });

  it('does NOT flag ordinary "waiting for" narration without the full idiom', () => {
    expect(narratesUnarmedWaitPromise('Waiting for your reply before proceeding.')).toBe(false);
    expect(narratesUnarmedWaitPromise('The build is still waiting for a runner.')).toBe(false);
  });
});

// FLUX-1436 (FLUX-1432 lead extension) — a non-chat group LEAD ending its turn terminally (no wakeup armed by
// definition: tryEnterScheduledWake claims scheduled turns first) while narrating a wait promise,
// with no deferred combiner registered for its group, has promised a resume nothing will honor.
// Pure decision; the claude adapter's leadWaitOverride supplies the session/session-store facts.
describe('leadUnarmedWaitMessage', () => {
  const base = {
    patternPosition: 'lead',
    groupId: 'g1',
    hasPendingCombiner: false,
    lastText: "I'll wait for the workers to report back, then synthesize.",
  };

  it('returns the specific message for a lead that promised an unarmed wait', () => {
    expect(leadUnarmedWaitMessage(base)).toContain('nothing is armed to resume it');
  });

  it('fires on the real incident phrasing', () => {
    expect(leadUnarmedWaitMessage({ ...base, lastText: 'Continuing to wait for the stabilization signal.' })).toBeDefined();
  });

  it('returns undefined when a pending combiner is registered — the gather step will resume the group', () => {
    expect(leadUnarmedWaitMessage({ ...base, hasPendingCombiner: true })).toBeUndefined();
  });

  it('returns undefined for non-lead or group-less sessions', () => {
    expect(leadUnarmedWaitMessage({ ...base, patternPosition: 'step' })).toBeUndefined();
    expect(leadUnarmedWaitMessage({ ...base, patternPosition: undefined })).toBeUndefined();
    expect(leadUnarmedWaitMessage({ ...base, groupId: undefined })).toBeUndefined();
  });

  it('returns undefined when the final text makes no wait promise', () => {
    expect(leadUnarmedWaitMessage({ ...base, lastText: 'All workers done; moving the ticket to Ready.' })).toBeUndefined();
    expect(leadUnarmedWaitMessage({ ...base, lastText: undefined })).toBeUndefined();
  });
});
