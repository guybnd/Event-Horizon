import { describe, it, expect } from 'vitest';
import { isParked, type ParkedSnapshot } from './parked-ticket.js';

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

  it('flags regardless of branchless vs branched (the decision does not look at the branch)', () => {
    // Same inputs reach isParked the same way whether or not the ticket has a branch.
    expect(isParked(base)).toBe(true);
  });

  it('handles a missing turn-start snapshot conservatively (no false "changed")', () => {
    expect(isParked({ ...base, statusAtTurnStart: undefined })).toBe(true);
  });
});
