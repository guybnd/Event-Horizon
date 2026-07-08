import { describe, it, expect } from 'vitest';
import { selectTicketsForList } from './mcp-server.js';

/**
 * FLUX-489: list_tickets active-by-default + limit + search. `selectTicketsForList` is
 * factored out of the handler so the selection/cap decision is a pure function (mirrors
 * the `describeEmptyTicketList` idiom).
 *
 * `over` intentionally allows arbitrary extra fields (not just `ListTicketRow`'s lean columns) —
 * the "keeps lean columns only" test below stuffs full-ticket-shaped fields (`body`, `history`,
 * `_path`) in to prove the selector trims them from its output.
 */
function ticket(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `${id} title`,
    status: 'Todo',
    priority: 'None',
    effort: 'None',
    assignee: 'unassigned',
    tags: [],
    ...over,
  };
}

describe('selectTicketsForList (FLUX-489)', () => {
  it('defaults to active-only: hides Done/Released/Archived and notes the hidden count', () => {
    const tasks = [
      ticket('FLUX-1', { status: 'Todo' }),
      ticket('FLUX-2', { status: 'In Progress' }),
      ticket('FLUX-3', { status: 'Done' }),
      ticket('FLUX-4', { status: 'Released' }),
      ticket('FLUX-5', { status: 'Archived' }),
    ];
    const { rows, note } = selectTicketsForList(tasks, {});
    expect(rows.map((r) => r.id)).toEqual(['FLUX-1', 'FLUX-2']);
    expect(note).toMatch(/3 terminal-status tickets/);
    expect(note).toMatch(/includeAll:true/);
  });

  it('all matches terminal: empty rows still disclose the hidden count + includeAll (no silent truncation)', () => {
    // Every ticket matching the filter is terminal, so the active-default screen
    // empties the result. The handler relies on this note to avoid a misleading
    // "nothing matched" — the rows are empty but the disclosure must survive.
    const tasks = [
      ticket('FLUX-1', { status: 'Done', tags: ['shipped'] }),
      ticket('FLUX-2', { status: 'Released', tags: ['shipped'] }),
      ticket('FLUX-3', { status: 'Todo', tags: ['other'] }),
    ];
    const { rows, note } = selectTicketsForList(tasks, { tag: 'shipped' });
    expect(rows).toEqual([]);
    expect(note).toMatch(/2 terminal-status tickets/);
    expect(note).toMatch(/includeAll:true/);
  });

  it('an explicit status overrides active-default (can list Done)', () => {
    const tasks = [ticket('FLUX-1', { status: 'Done' }), ticket('FLUX-2', { status: 'Todo' })];
    const { rows, note } = selectTicketsForList(tasks, { status: 'Done' });
    expect(rows.map((r) => r.id)).toEqual(['FLUX-1']);
    expect(note).toBeUndefined();
  });

  it('caps at the default limit of 40 and notes how to see more', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ticket(`FLUX-${i + 1}`));
    const { rows, note } = selectTicketsForList(tasks, {});
    expect(rows).toHaveLength(40);
    expect(note).toMatch(/Showing 40 of 50 matched/);
    expect(note).toMatch(/raise limit/);
  });

  it('respects an explicit limit', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ticket(`FLUX-${i + 1}`));
    const { rows, note } = selectTicketsForList(tasks, { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(note).toMatch(/Showing 3 of 10 matched/);
  });

  it('includeAll ignores both the active screen and the limit', () => {
    const tasks = [
      ...Array.from({ length: 50 }, (_, i) => ticket(`FLUX-${i + 1}`)),
      ticket('FLUX-DONE', { status: 'Done' }),
    ];
    const { rows, note } = selectTicketsForList(tasks, { includeAll: true });
    expect(rows).toHaveLength(51);
    expect(note).toBeUndefined();
  });

  it('search matches id and title case-insensitively', () => {
    const tasks = [
      ticket('FLUX-1', { title: 'Redesign the list endpoint' }),
      ticket('FLUX-2', { title: 'Unrelated work' }),
      ticket('FLUX-42', { title: 'Other' }),
    ];
    expect(selectTicketsForList(tasks, { search: 'redesign' }).rows.map((r) => r.id)).toEqual([
      'FLUX-1',
    ]);
    expect(selectTicketsForList(tasks, { search: 'flux-42' }).rows.map((r) => r.id)).toEqual([
      'FLUX-42',
    ]);
  });

  it('active:false includes terminal statuses without an explicit status', () => {
    const tasks = [ticket('FLUX-1', { status: 'Todo' }), ticket('FLUX-2', { status: 'Done' })];
    const { rows } = selectTicketsForList(tasks, { active: false });
    expect(rows.map((r) => r.id)).toEqual(['FLUX-1', 'FLUX-2']);
  });

  it("FLUX-1225: hides kind:'scratch' from the active-default screen (silently — not counted as terminal)", () => {
    const tasks = [
      ticket('FLUX-1', { status: 'Todo' }),
      ticket('SCRATCH-1', { status: 'Todo', kind: 'scratch' }),
      ticket('FLUX-2', { status: 'Done' }),
    ];
    const { rows, note } = selectTicketsForList(tasks, {});
    expect(rows.map((r) => r.id)).toEqual(['FLUX-1']);
    // The scratch chat drops without a nudge; the note reflects ONLY the terminal ticket.
    expect(note).toMatch(/1 terminal-status ticket\b/);
    expect(note).not.toMatch(/2 terminal-status/);
  });

  it("FLUX-1225: an explicit status reaches a kind:'scratch' entity (escape hatch)", () => {
    const tasks = [ticket('SCRATCH-1', { status: 'Todo', kind: 'scratch' }), ticket('FLUX-1', { status: 'Todo' })];
    expect(selectTicketsForList(tasks, { status: 'Todo' }).rows.map((r) => r.id)).toEqual(['SCRATCH-1', 'FLUX-1']);
    expect(selectTicketsForList(tasks, { includeAll: true }).rows.map((r) => r.id)).toEqual(['SCRATCH-1', 'FLUX-1']);
  });

  it('keeps lean columns only', () => {
    const tasks = [ticket('FLUX-1', { body: 'big body', history: [{}], _path: '/x' })];
    const { rows } = selectTicketsForList(tasks, {});
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['assignee', 'effort', 'id', 'priority', 'status', 'tags', 'title'].sort(),
    );
  });
});
