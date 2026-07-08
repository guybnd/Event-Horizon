// The Furnace — batch builder / curation (FLUX-1051 intentional-selection contract).
//
// `buildBatchTickets` used to accept a bare `{ statuses: ['Todo'] }` scan with no selector at all,
// pooling the entire groomed backlog, and silently dropped a tagged-but-wrong-status ticket with no
// trace in `excluded`. These tests pin the fix: a build refuses without `tag`/`tickets`, every tagged or
// explicitly-named ticket is accounted for exactly once (loaded or excluded with a reason), and a ticket
// already queued in another non-terminal batch is excluded rather than double-loaded.

import { describe, it, expect } from 'vitest';
import { buildBatchTickets, findActiveBatchFor, type BuildCandidate } from './furnace-builder.js';
import type { FurnaceBatch } from './models/furnace.js';

function candidate(overrides: Partial<BuildCandidate> & { id: string }): BuildCandidate {
  return { status: 'Todo', ...overrides };
}

function fakeBatch(id: string, status: FurnaceBatch['status'], ticketIds: string[]): FurnaceBatch {
  return {
    id,
    status,
    tickets: ticketIds.map((ticketId) => ({ ticketId })),
  } as unknown as FurnaceBatch;
}

describe('buildBatchTickets — no selector, no scan (FLUX-1051)', () => {
  it('refuses to build with neither a tag nor explicit ids', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1' }), candidate({ id: 'FLUX-2' })], {});
    expect(proposal.tickets).toEqual([]);
    expect(proposal.excluded).toEqual([]);
    expect(proposal.notes[0]).toMatch(/requires an explicit selector/);
  });

  it('treats an empty explicit tickets[] the same as no selector at all', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1' })], { tickets: [] });
    expect(proposal.tickets).toEqual([]);
    expect(proposal.notes[0]).toMatch(/requires an explicit selector/);
  });
});

describe('buildBatchTickets — tag selector + full accounting (FLUX-1051)', () => {
  it('loads only tagged tickets; an untagged ticket is never considered at all', () => {
    const proposal = buildBatchTickets(
      [candidate({ id: 'FLUX-1', tags: ['burn-furnace'] }), candidate({ id: 'FLUX-2' })],
      { tag: 'burn-furnace' },
    );
    expect(proposal.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    expect(proposal.excluded).toEqual([]);
  });

  it('a tagged ticket in the wrong status is excluded with a reason, not silently dropped', () => {
    const proposal = buildBatchTickets(
      [
        candidate({ id: 'FLUX-1', tags: ['burn-furnace'] }),
        candidate({ id: 'FLUX-2', tags: ['burn-furnace'], status: 'Grooming' }),
      ],
      { tag: 'burn-furnace' },
    );
    expect(proposal.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    expect(proposal.excluded).toEqual([{ ticketId: 'FLUX-2', reason: 'tagged but status Grooming (not allowed)' }]);
    expect(proposal.notes[0]).toBe('⚠ 1 tagged ticket(s) NOT loaded — see excluded.');
  });

  it('echoes a non-default statuses override in the notes', () => {
    const proposal = buildBatchTickets(
      [candidate({ id: 'FLUX-1', tags: ['burn-furnace'], status: 'In Progress' })],
      { tag: 'burn-furnace', statuses: ['In Progress'] },
    );
    expect(proposal.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    expect(proposal.notes).toContain('Scan window overridden: In Progress.');
  });

  it('caps by limit and accounts every truncated ticket in excluded', () => {
    const candidates = ['FLUX-1', 'FLUX-2', 'FLUX-3'].map((id) => candidate({ id, tags: ['burn-furnace'] }));
    const proposal = buildBatchTickets(candidates, { tag: 'burn-furnace', limit: 2 });
    expect(proposal.tickets.length).toBe(2);
    expect(proposal.excluded).toEqual([{ ticketId: 'FLUX-3', reason: 'capped by limit' }]);
  });

  it('does not claim an override when statuses is explicitly passed but equals the real default', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1', tags: ['burn-furnace'] })], {
      tag: 'burn-furnace',
      statuses: ['Todo'],
    });
    expect(proposal.notes.some((n) => n.includes('overridden'))).toBe(false);
  });
});

describe('buildBatchTickets — explicit-ids selector runs the same curation as a tag scan (FLUX-1051)', () => {
  it('excludes a parent whenever its loaded subtask is also named', () => {
    const proposal = buildBatchTickets(
      [candidate({ id: 'FLUX-1', subtasks: ['FLUX-2'] }), candidate({ id: 'FLUX-2', parentId: 'FLUX-1' })],
      { tickets: ['FLUX-1', 'FLUX-2'] },
    );
    expect(proposal.tickets.map((t) => t.ticketId)).toEqual(['FLUX-2']);
    expect(proposal.excluded.some((e) => e.ticketId === 'FLUX-1' && e.reason.includes('parent of loaded ticket'))).toBe(true);
  });

  it('accounts an unknown explicit id as `unknown ticket id`', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1' })], { tickets: ['FLUX-1', 'FLUX-999'] });
    expect(proposal.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    expect(proposal.excluded).toEqual([{ ticketId: 'FLUX-999', reason: 'unknown ticket id' }]);
  });

  it('an explicit id in the wrong status gets a plain status reason (not "tagged")', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1', status: 'Done' })], { tickets: ['FLUX-1'] });
    expect(proposal.tickets).toEqual([]);
    expect(proposal.excluded).toEqual([{ ticketId: 'FLUX-1', reason: 'status Done (not allowed)' }]);
  });

  it('dedupes a repeated unknown id so it is only accounted for once', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1' })], { tickets: ['FLUX-999', 'FLUX-999'] });
    expect(proposal.excluded).toEqual([{ ticketId: 'FLUX-999', reason: 'unknown ticket id' }]);
  });
});

describe('buildBatchTickets — one-active-batch invariant (FLUX-1051)', () => {
  it('excludes a ticket already queued in another non-terminal batch', () => {
    const other = fakeBatch('batch-1', 'burning', ['FLUX-1']);
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1', tags: ['burn-furnace'] })], {
      tag: 'burn-furnace',
      activeBatches: [other],
    });
    expect(proposal.tickets).toEqual([]);
    expect(proposal.excluded).toEqual([{ ticketId: 'FLUX-1', reason: 'already queued in batch batch-1' }]);
  });

  it('a ticket in a terminal (done/parked) batch is free to be re-selected', () => {
    for (const status of ['done', 'parked'] as const) {
      const other = fakeBatch('batch-1', status, ['FLUX-1']);
      const proposal = buildBatchTickets([candidate({ id: 'FLUX-1', tags: ['burn-furnace'] })], {
        tag: 'burn-furnace',
        activeBatches: [other],
      });
      expect(proposal.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    }
  });
});

describe('buildBatchTickets — live-session soft-flag (FLUX-1235)', () => {
  it('soft-flags (does not exclude) a candidate with a live session and summarizes it', () => {
    const proposal = buildBatchTickets(
      [candidate({ id: 'FLUX-1', tags: ['burn-furnace'] }), candidate({ id: 'FLUX-2', tags: ['burn-furnace'] })],
      { tag: 'burn-furnace', liveSessionTicketIds: new Set(['FLUX-1']) },
    );
    // Still loaded (flag, not block), and accounted for nowhere in excluded.
    expect(proposal.tickets.map((t) => t.ticketId).sort()).toEqual(['FLUX-1', 'FLUX-2']);
    expect(proposal.excluded).toEqual([]);
    const flagged = proposal.tickets.find((t) => t.ticketId === 'FLUX-1');
    expect(flagged?.note).toMatch(/live session/);
    expect(proposal.tickets.find((t) => t.ticketId === 'FLUX-2')?.note).toBeUndefined();
    expect(proposal.notes.some((n) => /have a live session/.test(n))).toBe(true);
  });

  it('does not flag anything when no candidate has a live session', () => {
    const proposal = buildBatchTickets([candidate({ id: 'FLUX-1', tags: ['burn-furnace'] })], {
      tag: 'burn-furnace',
      liveSessionTicketIds: new Set(),
    });
    expect(proposal.tickets[0]?.note).toBeUndefined();
    expect(proposal.notes.some((n) => /live session/.test(n))).toBe(false);
  });
});

describe('findActiveBatchFor', () => {
  it('returns the owning non-terminal batch id', () => {
    expect(findActiveBatchFor('FLUX-1', [fakeBatch('b1', 'draft', ['FLUX-1'])])).toBe('b1');
    expect(findActiveBatchFor('FLUX-1', [fakeBatch('b1', 'burning', ['FLUX-1'])])).toBe('b1');
  });

  it('ignores terminal (done/parked) batches', () => {
    expect(findActiveBatchFor('FLUX-1', [fakeBatch('b1', 'done', ['FLUX-1'])])).toBeUndefined();
    expect(findActiveBatchFor('FLUX-1', [fakeBatch('b1', 'parked', ['FLUX-1'])])).toBeUndefined();
  });

  it('excludes the given batch id (so a batch can keep re-saving its own tickets)', () => {
    expect(findActiveBatchFor('FLUX-1', [fakeBatch('b1', 'burning', ['FLUX-1'])], { excludeBatchId: 'b1' })).toBeUndefined();
  });

  it('returns undefined when no batch owns the ticket', () => {
    expect(findActiveBatchFor('FLUX-1', [fakeBatch('b1', 'burning', ['FLUX-2'])])).toBeUndefined();
  });
});
