import { describe, it, expect, beforeEach, vi } from 'vitest';

// resolveMergedPrTickets touches the engine's task store + event bus; mock both so the unit test
// asserts the resolution behavior without real disk writes or socket emits. The pure-logic tests
// below don't use either, so the mocks are inert for them.
vi.mock('./task-store.js', () => ({
  tasksCache: {},
  upsertManagedTicket: vi.fn().mockResolvedValue(undefined),
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./events.js', () => ({ broadcastEvent: vi.fn() }));

// syncPrTickets shells out to `gh` via runGh (git-exec.js, FLUX-1001); mock it so the test feeds
// a canned `gh pr list --json …` payload (FLUX-751: asserting the PR body is threaded through).
const ghState = vi.hoisted(() => ({ stdout: '[]' }));
vi.mock('./git-exec.js', () => ({
  runGh: vi.fn(async () => ({ stdout: ghState.stdout, stderr: '' })),
}));

import { tasksCache, upsertManagedTicket } from './task-store.js';
import { broadcastEvent } from './events.js';
import { selectMembers, prTicketFields, prTicketId, sharedNonDoneSiblings, membersToBounce, prTicketsOnBranch, resolveMergedPrTickets, syncPrTickets } from './pr-tickets.js';

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
  const base = { number: 9, title: 'Add thing', url: 'https://gh/pr/9', state: 'OPEN', headRefName: 'feature/x', reviewDecision: null, isDraft: false, body: 'The PR description.' };

  it('a NEW open PR lands in Ready with kind:pr + metadata', () => {
    const f = prTicketFields(base, ['FLUX-1'], null);
    expect(f.kind).toBe('pr');
    expect(f.status).toBe('Ready');
    expect(f.prNumber).toBe(9);
    expect(f.branch).toBe('feature/x');
    expect(f.members).toEqual(['FLUX-1']);
    expect(f.swimlane).toBeNull();
  });

  it('does NOT set status for an existing open PR ticket (send-for-review not clobbered)', () => {
    const f = prTicketFields(base, [], { status: 'In Progress', prState: 'OPEN' });
    expect('status' in f).toBe(false);
  });

  it('CHANGES_REQUESTED bounces the PR ticket to In Progress + flags the tint (FLUX-569)', () => {
    const f = prTicketFields({ ...base, reviewDecision: 'CHANGES_REQUESTED' }, [], { status: 'Ready', prState: 'OPEN' });
    expect(f.status).toBe('In Progress');
    expect(f.swimlane).toBe('changes-requested');
  });

  it('a reopened PR (was Done/CLOSED, now OPEN again) climbs back out of Done → Ready (FLUX-569)', () => {
    const f = prTicketFields(base, [], { status: 'Done', prState: 'CLOSED' });
    expect(f.status).toBe('Ready');
    expect(f.prState).toBe('OPEN'); // stale terminal state cleared
  });

  it('a reopened PR detected via prState MERGED also resets to Ready', () => {
    const f = prTicketFields(base, [], { status: 'Done', prState: 'MERGED' });
    expect(f.status).toBe('Ready');
  });

  it('prTicketId uses the gh number', () => {
    expect(prTicketId(42)).toBe('PR-42');
  });
});

/** FLUX-569: the finish-on-shared-PR one-way-door guard (from the FLUX-556/PR#6 incident). */
describe('sharedNonDoneSiblings (finish-on-shared-PR guard)', () => {
  const tickets = [
    { id: 'FLUX-1', branch: 'feature/x', status: 'Ready' },        // self (the one finishing)
    { id: 'FLUX-2', branch: 'feature/x', status: 'In Progress' },  // non-Done sibling → swept
    { id: 'FLUX-3', branch: 'feature/x', status: 'Todo' },         // non-Done sibling → swept
    { id: 'FLUX-4', branch: 'feature/x', status: 'Done' },         // terminal → safe
    { id: 'FLUX-5', branch: 'feature/x', status: 'Released' },     // terminal → safe
    { id: 'FLUX-6', branch: 'feature/y', status: 'In Progress' },  // different branch → safe
    { id: 'PR-9', branch: 'feature/x', status: 'Ready', kind: 'pr' }, // PR ticket → exempt
  ];

  it('refuses: returns non-Done siblings that share the branch (excluding self)', () => {
    const blockers = sharedNonDoneSiblings(tickets, 'feature/x', 'FLUX-1');
    expect(blockers.map((t) => t.id).sort()).toEqual(['FLUX-2', 'FLUX-3']);
  });

  it('exempts PR tickets — merging a PR ticket to advance its members is sanctioned', () => {
    const blockers = sharedNonDoneSiblings(tickets, 'feature/x', 'FLUX-1');
    expect(blockers.map((t) => t.id)).not.toContain('PR-9');
  });

  it('treats Done/Released/Archived siblings as safe (no live work to sweep)', () => {
    const blockers = sharedNonDoneSiblings(tickets, 'feature/x', 'FLUX-1');
    expect(blockers.map((t) => t.id)).not.toContain('FLUX-4');
    expect(blockers.map((t) => t.id)).not.toContain('FLUX-5');
  });

  it('force overrides the guard — only `!force && blockers.length > 0` refuses', () => {
    // Mirrors the guard composition at both call sites (mcp finish + REST merge).
    const blocked = (force: boolean) => !force && sharedNonDoneSiblings(tickets, 'feature/x', 'FLUX-1').length > 0;
    expect(blocked(false)).toBe(true);  // non-Done siblings present → refuse
    expect(blocked(true)).toBe(false);  // force:true lands the whole shared PR anyway
  });

  it('a solo branch (no other non-Done tickets) has no blockers', () => {
    expect(sharedNonDoneSiblings(tickets, 'feature/y', 'FLUX-6')).toEqual([]);
  });
});

/** FLUX-569: the changes-requested unwind is Ready-only + idempotent across the 90s poll. */
describe('membersToBounce (changes-requested unwind idempotency)', () => {
  it('selects only Ready members; In Progress members are left alone', () => {
    const tickets = [
      { id: 'FLUX-1', status: 'Ready' },
      { id: 'FLUX-2', status: 'In Progress' },
      { id: 'FLUX-3', status: 'Ready' },
    ];
    expect(membersToBounce(tickets, ['FLUX-1', 'FLUX-2', 'FLUX-3'])).toEqual(['FLUX-1', 'FLUX-3']);
  });

  it('repeat-poll no-op: once bounced to In Progress, a second poll selects nothing', () => {
    const memberIds = ['FLUX-1', 'FLUX-2'];
    const beforeBounce = [
      { id: 'FLUX-1', status: 'Ready' },
      { id: 'FLUX-2', status: 'Ready' },
    ];
    expect(membersToBounce(beforeBounce, memberIds)).toEqual(['FLUX-1', 'FLUX-2']);
    // The unwind moved them to In Progress; the next 90s poll must not re-comment.
    const afterBounce = beforeBounce.map((t) => ({ ...t, status: 'In Progress' }));
    expect(membersToBounce(afterBounce, memberIds)).toEqual([]);
  });

  it('drops unknown member ids (a resolved ticket that is no longer a member)', () => {
    const tickets = [{ id: 'FLUX-1', status: 'Ready' }];
    expect(membersToBounce(tickets, ['FLUX-1', 'FLUX-GONE'])).toEqual(['FLUX-1']);
  });
});

/** FLUX-591: the pure selection used by the immediate post-merge PR-ticket resolution. */
describe('prTicketsOnBranch (pure selection)', () => {
  const tickets = [
    { id: 'PR-9', kind: 'pr', branch: 'feature/x' },
    { id: 'PR-8', kind: 'pr', branch: 'feature/y' },   // different branch → excluded
    { id: 'FLUX-1', branch: 'feature/x', status: 'Ready' }, // normal ticket → excluded
    null,                                               // tolerate sparse cache entries
  ];

  it('selects only kind:pr tickets on the given branch', () => {
    expect(prTicketsOnBranch(tickets, 'feature/x').map((t) => t.id)).toEqual(['PR-9']);
  });

  it('returns [] when no PR ticket points at the branch', () => {
    expect(prTicketsOnBranch(tickets, 'feature/none')).toEqual([]);
  });
});

/**
 * FLUX-591 / FLUX-588: POST /:id/pr/merge calls resolveMergedPrTickets right after the squash-merge
 * so a merged PR card flips to Done immediately, without waiting for the 90s syncPrTickets poll.
 */
describe('resolveMergedPrTickets (immediate post-merge PR resolution)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete (tasksCache as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
    vi.mocked(broadcastEvent).mockClear();
  });

  it('resolves only the branch\'s PR tickets to Done + MERGED + swimlane:null, immediately', async () => {
    Object.assign(tasksCache, {
      'PR-9': { id: 'PR-9', kind: 'pr', branch: 'feature/x', status: 'Ready', prState: 'OPEN' },
      'FLUX-1': { id: 'FLUX-1', branch: 'feature/x', status: 'Ready' }, // normal member → not this fn's job
      'PR-8': { id: 'PR-8', kind: 'pr', branch: 'feature/y', status: 'Ready' }, // other branch → untouched
    });

    const resolved = await resolveMergedPrTickets('feature/x');

    expect(resolved).toEqual(['PR-9']);
    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-9', { status: 'Done', prState: 'MERGED', swimlane: null });
    expect(vi.mocked(broadcastEvent)).toHaveBeenCalledWith('taskUpdated', { id: 'PR-9' });
  });

  it('is a no-op when the merged branch carries no PR ticket', async () => {
    Object.assign(tasksCache, { 'FLUX-1': { id: 'FLUX-1', branch: 'feature/x', status: 'Ready' } });

    const resolved = await resolveMergedPrTickets('feature/x');

    expect(resolved).toEqual([]);
    expect(vi.mocked(upsertManagedTicket)).not.toHaveBeenCalled();
    expect(vi.mocked(broadcastEvent)).not.toHaveBeenCalled();
  });
});

/** FLUX-751: syncPrTickets pulls the gh PR description into the card body (3rd upsert arg). */
describe('syncPrTickets (PR body carried into the card)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete (tasksCache as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
  });

  it('threads the gh PR description through as the upsert body (3rd arg)', async () => {
    ghState.stdout = JSON.stringify([
      { number: 9, title: 'Add thing', url: 'https://gh/pr/9', state: 'OPEN', headRefName: 'feature/x', reviewDecision: null, isDraft: false, body: 'The PR description.' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-9', expect.any(Object), 'The PR description.');
    // body is the markdown carrier, NOT a frontmatter field.
    const fields = vi.mocked(upsertManagedTicket).mock.calls[0]![1];
    expect('body' in fields).toBe(false);
  });

  it('coerces a null/missing PR description to an empty body (no crash)', async () => {
    ghState.stdout = JSON.stringify([
      { number: 10, title: 'No desc', url: 'https://gh/pr/10', state: 'OPEN', headRefName: 'feature/y', reviewDecision: null, isDraft: false, body: null },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-10', expect.any(Object), '');
  });
});
