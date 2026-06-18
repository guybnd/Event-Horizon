import { describe, it, expect } from 'vitest';
import { selectMembers, prTicketFields, prTicketId } from './pr-tickets.js';

/** FLUX-566: work-gated PR membership + gh-state→ticket-field mapping (pure logic). */
describe('selectMembers (work-gated membership)', () => {
  const tickets = [
    { id: 'FLUX-1', branch: 'feature/x', status: 'In Progress' },
    { id: 'FLUX-2', branch: 'feature/x', status: 'Ready' },
    { id: 'FLUX-3', branch: 'feature/x', status: 'Todo' },       // not yet worked → excluded
    { id: 'FLUX-4', branch: 'feature/x', status: 'Backlog' },    // not yet worked → excluded
    { id: 'FLUX-5', branch: 'feature/x', status: 'Grooming' },   // not yet worked → excluded
    { id: 'FLUX-6', branch: 'feature/y', status: 'In Progress' },// different branch → excluded
    { id: 'PR-9', branch: 'feature/x', status: 'Ready', kind: 'pr' }, // a PR ticket → excluded
    { id: 'FLUX-7', status: 'In Progress' },                     // no branch → excluded
  ];

  it('includes only In Progress / Ready tickets on the branch', () => {
    expect(selectMembers(tickets, 'feature/x')).toEqual(['FLUX-1', 'FLUX-2']);
  });

  it('excludes Todo/Grooming/Backlog (un-worked tickets stay in their pile)', () => {
    const members = selectMembers(tickets, 'feature/x');
    expect(members).not.toContain('FLUX-3');
    expect(members).not.toContain('FLUX-4');
    expect(members).not.toContain('FLUX-5');
  });

  it('never folds a PR ticket into another PR', () => {
    expect(selectMembers(tickets, 'feature/x')).not.toContain('PR-9');
  });

  it('returns [] for a branch with no worked tickets', () => {
    expect(selectMembers(tickets, 'feature/none')).toEqual([]);
  });
});

describe('prTicketFields (state mapping)', () => {
  const base = { number: 9, title: 'Add thing', url: 'https://gh/pr/9', state: 'OPEN', headRefName: 'feature/x', reviewDecision: null, isDraft: false };

  it('a NEW open PR lands in Ready with kind:pr + metadata', () => {
    const f = prTicketFields(base, ['FLUX-1'], true);
    expect(f.kind).toBe('pr');
    expect(f.status).toBe('Ready');
    expect(f.prNumber).toBe(9);
    expect(f.branch).toBe('feature/x');
    expect(f.members).toEqual(['FLUX-1']);
    expect(f.swimlane).toBeNull();
  });

  it('does NOT set status for an existing PR ticket (send-for-review not clobbered)', () => {
    const f = prTicketFields(base, [], false);
    expect('status' in f).toBe(false);
  });

  it('CHANGES_REQUESTED flags the changes-requested swimlane', () => {
    const f = prTicketFields({ ...base, reviewDecision: 'CHANGES_REQUESTED' }, [], false);
    expect(f.swimlane).toBe('changes-requested');
  });

  it('prTicketId uses the gh number', () => {
    expect(prTicketId(42)).toBe('PR-42');
  });
});
