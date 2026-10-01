import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// resolveMergedPrTickets touches the engine's task store + event bus; mock both so the unit test
// asserts the resolution behavior without real disk writes or socket emits. The pure-logic tests
// below don't use either, so the mocks are inert for them.
vi.mock('./task-store.js', () => ({
  upsertManagedTicket: vi.fn().mockResolvedValue(undefined),
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./events.js', () => ({ broadcastEvent: vi.fn() }));

// syncPrTickets shells out to `gh` via runGh (git-exec.js, FLUX-1001); mock it so the test feeds
// a canned `gh pr list --json …` payload (FLUX-751: asserting the PR body is threaded through).
// FLUX-1713 review: dispatch on argv rather than returning `ghState.stdout` for ANY call —
// syncPrTickets also calls getCiRunnerInfo, which shells out to `gh api .../actions/runs` and
// `.../jobs` via the same runGh. A blanket mock fed the `pr list` array back to those calls too,
// so getCiRunnerInfo always parsed it as `{ workflow_runs: undefined }` and silently returned
// undefined — every ciRunner-touching test would keep passing even if the plumbing were deleted.
const ghState = vi.hoisted(() => ({
  stdout: '[]',
  runsStdout: JSON.stringify({ workflow_runs: [] }),
  jobsStdout: JSON.stringify({ jobs: [] }),
}));
vi.mock('./git-exec.js', () => ({
  runGh: vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: ghState.stdout, stderr: '' };
    if (args[1] === 'repos/{owner}/{repo}/actions/runs') return { stdout: ghState.runsStdout, stderr: '' };
    if (typeof args[1] === 'string' && args[1].includes('/jobs')) return { stdout: ghState.jobsStdout, stderr: '' };
    return { stdout: ghState.stdout, stderr: '' };
  }),
}));

// FLUX-1076: syncPrTickets checks isSyncUnhealthy() before creating a brand-new PR ticket.
// Mock it with a mutable hoisted flag so tests can flip sync health per-case.
const syncHealthState = vi.hoisted(() => ({ unhealthy: false }));
vi.mock('./sync-watcher.js', () => ({
  isSyncUnhealthy: vi.fn(() => syncHealthState.unhealthy),
}));

import { upsertManagedTicket, updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { selectMembers, prTicketFields, prTicketId, sharedNonDoneSiblings, membersToBounce, prTicketsOnBranch, resolveMergedPrTickets, syncPrTickets, deriveCiStatus } from './pr-tickets.js';
import { invalidateCiRunnerCache, type CiRunnerInfo } from './ci-runner.js';

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

  // FLUX-986: merge-conflict is set OUTSIDE this mapper (the portal-Merge conflict bounce); this
  // poller doesn't own clearing it, so it must not stomp it back to null on the next 90s poll.
  it('preserves an existing merge-conflict swimlane while the PR is still open (FLUX-986)', () => {
    const f = prTicketFields(base, [], { status: 'In Progress', prState: 'OPEN', swimlane: 'merge-conflict' });
    expect(f.swimlane).toBe('merge-conflict');
  });

  it('CHANGES_REQUESTED overrides a stale merge-conflict swimlane (FLUX-986)', () => {
    const f = prTicketFields({ ...base, reviewDecision: 'CHANGES_REQUESTED' }, [], { status: 'In Progress', prState: 'OPEN', swimlane: 'merge-conflict' });
    expect(f.swimlane).toBe('changes-requested');
  });

  it('prTicketId uses the gh number', () => {
    expect(prTicketId(42)).toBe('PR-42');
  });

  // FLUX-1315: ciStatus is derived from the raw gh rollup and always present on the fields object.
  it('derives ciStatus from statusCheckRollup (unknown when absent)', () => {
    expect(prTicketFields(base, [], null).ciStatus).toBe('unknown');
    const failing = { ...base, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] };
    expect(prTicketFields(failing, [], null).ciStatus).toBe('failing');
  });

  // FLUX-1713: the optional 4th param threads getCiRunnerInfo's result onto the card. A miss
  // must OMIT the key (not null it) so a transient gh failure never blanks the last-known-good
  // chip already on disk.
  it('sets ciRunner when the 4th param is provided, stripping checkedAt', () => {
    const runner: CiRunnerInfo = { origin: 'self-hosted', runnerName: 'box-1', jobs: [], checkedAt: '2026-01-01T00:00:00.000Z' };
    const f = prTicketFields(base, [], null, runner);
    // FLUX-1713 review (Major 3): checkedAt must NOT be persisted — nothing reads it, and
    // keeping it made every cache-TTL re-probe rewrite the card even when the verdict didn't change.
    expect(f.ciRunner).toEqual({ origin: 'self-hosted', runnerName: 'box-1', jobs: [] });
  });

  it('omits ciRunner (not null) when the 4th param is undefined', () => {
    const f = prTicketFields(base, [], null);
    expect('ciRunner' in f).toBe(false);
  });
});

/**
 * FLUX-1315: pure aggregation of GitHub's check-run rollup into one small signal for the PR-card
 * chip. Covers both node shapes the GraphQL union can return (CheckRun via status/conclusion,
 * StatusContext via state) and the representative all-success/one-failure/one-pending/empty cases
 * called out in the ticket's recommended tests.
 */
describe('deriveCiStatus (CI rollup aggregation)', () => {
  it('unknown for an empty/missing rollup (no checks configured)', () => {
    expect(deriveCiStatus(undefined)).toBe('unknown');
    expect(deriveCiStatus(null)).toBe('unknown');
    expect(deriveCiStatus([])).toBe('unknown');
  });

  it('passing when every CheckRun completed with a success-ish conclusion', () => {
    expect(deriveCiStatus([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
    ])).toBe('passing');
  });

  it('failing when any CheckRun concluded with a failing outcome', () => {
    expect(deriveCiStatus([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('failing');
  });

  it('pending when a CheckRun has not completed yet (and nothing has failed)', () => {
    expect(deriveCiStatus([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: null },
    ])).toBe('pending');
  });

  it('failing wins over pending when both are present', () => {
    expect(deriveCiStatus([
      { status: 'IN_PROGRESS', conclusion: null },
      { status: 'COMPLETED', conclusion: 'CANCELLED' },
    ])).toBe('failing');
  });

  it('handles the legacy StatusContext shape (state instead of status/conclusion)', () => {
    expect(deriveCiStatus([{ state: 'SUCCESS' }])).toBe('passing');
    expect(deriveCiStatus([{ state: 'ERROR' }])).toBe('failing');
    expect(deriveCiStatus([{ state: 'PENDING' }])).toBe('pending');
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
    for (const k of Object.keys(getWorkspace().tasks)) delete (getWorkspace().tasks as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
    vi.mocked(broadcastEvent).mockClear();
  });

  it('resolves only the branch\'s PR tickets to Done + MERGED + swimlane:null, immediately', async () => {
    Object.assign(getWorkspace().tasks, {
      'PR-9': { id: 'PR-9', kind: 'pr', branch: 'feature/x', status: 'Ready', prState: 'OPEN' },
      'FLUX-1': { id: 'FLUX-1', branch: 'feature/x', status: 'Ready' }, // normal member → not this fn's job
      'PR-8': { id: 'PR-8', kind: 'pr', branch: 'feature/y', status: 'Ready' }, // other branch → untouched
    });

    const resolved = await resolveMergedPrTickets('feature/x');

    expect(resolved).toEqual(['PR-9']);
    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-9', { status: 'Done', prState: 'MERGED', swimlane: null }, '', expect.any(Object));
    expect(vi.mocked(broadcastEvent)).toHaveBeenCalledWith('taskUpdated', { id: 'PR-9' });
  });

  it('is a no-op when the merged branch carries no PR ticket', async () => {
    Object.assign(getWorkspace().tasks, { 'FLUX-1': { id: 'FLUX-1', branch: 'feature/x', status: 'Ready' } });

    const resolved = await resolveMergedPrTickets('feature/x');

    expect(resolved).toEqual([]);
    expect(vi.mocked(upsertManagedTicket)).not.toHaveBeenCalled();
    expect(vi.mocked(broadcastEvent)).not.toHaveBeenCalled();
  });
});

/** FLUX-751: syncPrTickets pulls the gh PR description into the card body (3rd upsert arg). */
describe('syncPrTickets (PR body carried into the card)', () => {
  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete (getWorkspace().tasks as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
  });

  it('threads the gh PR description through as the upsert body (3rd arg)', async () => {
    ghState.stdout = JSON.stringify([
      { number: 9, title: 'Add thing', url: 'https://gh/pr/9', state: 'OPEN', headRefName: 'feature/x', reviewDecision: null, isDraft: false, body: 'The PR description.' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-9', expect.any(Object), 'The PR description.', expect.any(Object));
    // body is the markdown carrier, NOT a frontmatter field.
    const fields = vi.mocked(upsertManagedTicket).mock.calls[0]![1];
    expect('body' in fields).toBe(false);
  });

  it('coerces a null/missing PR description to an empty body (no crash)', async () => {
    ghState.stdout = JSON.stringify([
      { number: 10, title: 'No desc', url: 'https://gh/pr/10', state: 'OPEN', headRefName: 'feature/y', reviewDecision: null, isDraft: false, body: null },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-10', expect.any(Object), '', expect.any(Object));
  });
});

/**
 * FLUX-1713 review (Major 2): the leaf (getCiRunnerInfo) was well tested, but syncPrTickets'
 * wiring of it onto the card was not, and the pre-existing blanket runGh mock actively masked
 * that gap (it fed `pr list`'s JSON back to the `actions/runs` call too, so getCiRunnerInfo
 * always missed and returned undefined). These tests dispatch the mock on argv so a real
 * runs+jobs payload reaches getCiRunnerInfo, and assert both the hit and the deliberate
 * omit-on-miss.
 */
describe('syncPrTickets threads ciRunner onto the card (FLUX-1713)', () => {
  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete (getWorkspace().tasks as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
    ghState.runsStdout = JSON.stringify({ workflow_runs: [] });
    ghState.jobsStdout = JSON.stringify({ jobs: [] });
    invalidateCiRunnerCache();
  });

  it('sets ciRunner on the card when the head sha resolves to a self-hosted run', async () => {
    ghState.stdout = JSON.stringify([
      { number: 20, title: 'Add thing', url: 'https://gh/pr/20', state: 'OPEN', headRefName: 'feature/runner', reviewDecision: null, isDraft: false, body: '', headRefOid: 'sha-runner-hit' },
    ]);
    ghState.runsStdout = JSON.stringify({ workflow_runs: [{ id: 99 }] });
    ghState.jobsStdout = JSON.stringify({ jobs: [{ name: 'check', labels: ['self-hosted', 'Linux'], runner_name: 'guy-cachyos-x8664-linux' }] });

    await syncPrTickets('/repo');

    const fields = vi.mocked(upsertManagedTicket).mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.ciRunner).toMatchObject({ origin: 'self-hosted', runnerName: 'guy-cachyos-x8664-linux' });
  });

  it('omits ciRunner (not null) on a miss — no workflow run found for the head sha', async () => {
    ghState.stdout = JSON.stringify([
      { number: 21, title: 'Add thing', url: 'https://gh/pr/21', state: 'OPEN', headRefName: 'feature/no-runner', reviewDecision: null, isDraft: false, body: '', headRefOid: 'sha-runner-miss' },
    ]);
    // ghState.runsStdout defaults to { workflow_runs: [] } from beforeEach — no run for this sha yet.

    await syncPrTickets('/repo');

    const fields = vi.mocked(upsertManagedTicket).mock.calls[0]![1] as Record<string, unknown>;
    expect('ciRunner' in fields).toBe(false);
  });

  // FLUX-1713 review (Major 3): getCiRunnerInfo stamps a fresh checkedAt on every cache-TTL
  // re-probe even when the verdict is byte-identical, and task-store's upsert detects change by
  // deep-comparing the persisted fields — so a leaked checkedAt would make an unchanged PR's card
  // look "changed" forever. Two syncPrTickets passes over the identical gh payload (simulating a
  // hit-TTL expiry re-probe with a new cache entry, via invalidateCiRunnerCache) must persist the
  // exact same ciRunner object so the deep-compare — and thus the rewrite/commit loop — sees no
  // change. This is the invariant that would have caught the regression.
  it('persists an identical ciRunner across two polls of an unchanged PR (no checkedAt leak)', async () => {
    ghState.stdout = JSON.stringify([
      { number: 22, title: 'Add thing', url: 'https://gh/pr/22', state: 'OPEN', headRefName: 'feature/stable', reviewDecision: null, isDraft: false, body: '', headRefOid: 'sha-stable' },
    ]);
    ghState.runsStdout = JSON.stringify({ workflow_runs: [{ id: 100 }] });
    ghState.jobsStdout = JSON.stringify({ jobs: [{ name: 'check', labels: ['self-hosted', 'Linux'], runner_name: 'guy-cachyos-x8664-linux' }] });

    await syncPrTickets('/repo');
    const firstFields = vi.mocked(upsertManagedTicket).mock.calls[0]![1] as Record<string, unknown>;

    invalidateCiRunnerCache(); // simulate the hit-TTL expiring and a fresh probe running
    vi.mocked(upsertManagedTicket).mockClear();
    await syncPrTickets('/repo');
    const secondFields = vi.mocked(upsertManagedTicket).mock.calls[0]![1] as Record<string, unknown>;

    expect(secondFields.ciRunner).toEqual(firstFields.ciRunner);
    expect(secondFields.ciRunner).not.toHaveProperty('checkedAt');
  });
});

/**
 * FLUX-1089: the changes-requested unwind bounces a Ready member back to In Progress — its
 * `reviewState` (e.g. 'approved' from its own EH review) is now stale, since the member is active
 * work again, not an approved-and-waiting ticket. bounceMembersToInProgress must clear it via the
 * same updateTaskWithHistory call that moves the status, so the staleness never round-trips to disk.
 */
describe('syncPrTickets clears a bounced member\'s stale reviewState (FLUX-1089)', () => {
  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete (getWorkspace().tasks as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
    vi.mocked(updateTaskWithHistory).mockClear();
    syncHealthState.unhealthy = false;
  });

  it('clears reviewState on the Ready member bounced by a CHANGES_REQUESTED PR', async () => {
    Object.assign(getWorkspace().tasks, {
      'PR-13': { id: 'PR-13', kind: 'pr', branch: 'feature/v', prNumber: 13, status: 'Ready', prState: 'OPEN' },
      'FLUX-1': { id: 'FLUX-1', branch: 'feature/v', status: 'Ready', reviewState: 'approved' },
    });
    ghState.stdout = JSON.stringify([
      { number: 13, title: 'Thing', url: 'https://gh/pr/13', state: 'OPEN', headRefName: 'feature/v', reviewDecision: 'CHANGES_REQUESTED', isDraft: false, body: '' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(updateTaskWithHistory)).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({
      nextStatus: 'In Progress',
      extraFields: { reviewState: null },
    }), expect.any(Object));
  });
});

/**
 * FLUX-986: the portal-Merge conflict bounce (routes/tasks.ts) sets `swimlane: 'merge-conflict'`
 * on a kind:'pr' deck-card ticket directly, outside syncPrTickets. The next 90s poll must not
 * silently wipe it back to null — that would erase the "Launch Rebase Session" CTA within ~90s
 * even though the underlying git conflict is still unresolved (the review round 2 catch).
 */
describe('syncPrTickets preserves the merge-conflict swimlane across a poll (FLUX-986)', () => {
  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete (getWorkspace().tasks as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
    syncHealthState.unhealthy = false;
  });

  it('does not clobber a merge-conflict swimlane on the next poll while the PR is still open', async () => {
    Object.assign(getWorkspace().tasks, {
      'PR-20': { id: 'PR-20', kind: 'pr', branch: 'feature/conflict', prNumber: 20, status: 'In Progress', prState: 'OPEN', swimlane: 'merge-conflict' },
    });
    ghState.stdout = JSON.stringify([
      { number: 20, title: 'Conflicted thing', url: 'https://gh/pr/20', state: 'OPEN', headRefName: 'feature/conflict', reviewDecision: null, isDraft: false, body: '' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-20', expect.objectContaining({ swimlane: 'merge-conflict' }), '', expect.any(Object));
  });

  it('CHANGES_REQUESTED still overrides a stale merge-conflict swimlane during a poll', async () => {
    Object.assign(getWorkspace().tasks, {
      'PR-21': { id: 'PR-21', kind: 'pr', branch: 'feature/conflict2', prNumber: 21, status: 'In Progress', prState: 'OPEN', swimlane: 'merge-conflict' },
    });
    ghState.stdout = JSON.stringify([
      { number: 21, title: 'Conflicted then reviewed', url: 'https://gh/pr/21', state: 'OPEN', headRefName: 'feature/conflict2', reviewDecision: 'CHANGES_REQUESTED', isDraft: false, body: '' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-21', expect.objectContaining({ swimlane: 'changes-requested' }), '', expect.any(Object));
  });
});

/**
 * FLUX-1076: while flux-data sync is wedged, getWorkspace().tasks can be stale — a PR whose full ticket
 * already exists on the remote just looks "missing" locally. Creating a fresh skeleton for it
 * guarantees an add/add conflict on the next successful pull, which is how the incident this
 * ticket hardens against kept re-triggering itself. Only NET-NEW creation defers; existing PR
 * tickets keep getting their normal lifecycle updates.
 */
describe('syncPrTickets defers new-ticket creation while sync is unhealthy (FLUX-1076)', () => {
  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete (getWorkspace().tasks as Record<string, unknown>)[k];
    vi.mocked(upsertManagedTicket).mockClear();
    syncHealthState.unhealthy = false;
  });

  it('skips creating a brand-new PR ticket while sync is unhealthy', async () => {
    syncHealthState.unhealthy = true;
    ghState.stdout = JSON.stringify([
      { number: 11, title: 'New PR', url: 'https://gh/pr/11', state: 'OPEN', headRefName: 'feature/z', reviewDecision: null, isDraft: false, body: '' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).not.toHaveBeenCalled();
  });

  it('still updates an existing PR ticket while sync is unhealthy', async () => {
    syncHealthState.unhealthy = true;
    Object.assign(getWorkspace().tasks, {
      'PR-11': { id: 'PR-11', kind: 'pr', branch: 'feature/z', status: 'Ready', prState: 'OPEN' },
    });
    ghState.stdout = JSON.stringify([
      { number: 11, title: 'New PR', url: 'https://gh/pr/11', state: 'OPEN', headRefName: 'feature/z', reviewDecision: 'CHANGES_REQUESTED', isDraft: false, body: '' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-11', expect.any(Object), '', expect.any(Object));
  });

  it('creates a new PR ticket normally once sync is healthy again', async () => {
    syncHealthState.unhealthy = false;
    ghState.stdout = JSON.stringify([
      { number: 12, title: 'Another PR', url: 'https://gh/pr/12', state: 'OPEN', headRefName: 'feature/w', reviewDecision: null, isDraft: false, body: '' },
    ]);

    await syncPrTickets('/repo');

    expect(vi.mocked(upsertManagedTicket)).toHaveBeenCalledWith('PR-12', expect.any(Object), '', expect.any(Object));
  });
});
