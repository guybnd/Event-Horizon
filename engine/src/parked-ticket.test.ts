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

  it('does NOT flag resting statuses (Todo / Ready / Done / Backlog)', () => {
    for (const status of ['Todo', 'Ready', 'Done', 'Backlog']) {
      expect(isParked({ ...base, status, statusAtTurnStart: status })).toBe(false);
    }
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
