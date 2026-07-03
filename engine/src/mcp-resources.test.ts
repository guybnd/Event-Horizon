import { describe, it, expect } from 'vitest';
import {
  resolveTicketResource,
  resolveDocResource,
  listActiveTicketResources,
  listDocResources,
} from './mcp-server.js';
import type { StoredDoc } from './file-utils.js';

/**
 * FLUX-949: MCP resources + resource templates (ticket:// board:// docs://). The
 * resolver/list helpers are factored out of the resource read/list callbacks so
 * the not-found / traversal / active-filter logic is a pure function, testable
 * without spinning up an MCP transport (mirrors the selectTicketsForList idiom).
 */

function ticket(id: string, over: Partial<any> = {}) {
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

function doc(path: string, over: Partial<StoredDoc> = {}): StoredDoc {
  return {
    path,
    title: path.split('/').pop() || path,
    body: `# ${path}\n\nbody of ${path}`,
    slug: (path.split('/').pop() || path).toLowerCase(),
    directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    _path: `/abs/.docs/${path}.md`,
    ...over,
  };
}

const TERMINAL = ['Done', 'Released', 'Archived'];

describe('resolveTicketResource (FLUX-949 ticket:// read)', () => {
  const tasks = { 'FLUX-949': ticket('FLUX-949'), 'FLUX-1': ticket('FLUX-1') };

  it('returns the task for an exact canonical id', () => {
    const r = resolveTicketResource('FLUX-949', tasks);
    expect(r.ok).toBe(true);
    expect(r.ok && r.task.id).toBe('FLUX-949');
  });

  it('trims surrounding whitespace before lookup', () => {
    const r = resolveTicketResource('  FLUX-1  ', tasks);
    expect(r.ok && r.task.id).toBe('FLUX-1');
  });

  it('rejects a bare numeric id as validation_failed (ambiguous project key)', () => {
    const r = resolveTicketResource('949', tasks);
    expect(r).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(r.ok === false && r.message).toMatch(/FLUX-949/);
  });

  it('returns not_found for an unknown (non-numeric) id, never empty content', () => {
    const r = resolveTicketResource('FLUX-0000', tasks);
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('returns not_found for a wrong project key', () => {
    const r = resolveTicketResource('APP-1', tasks);
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('rejects an empty / non-string id as validation_failed', () => {
    expect(resolveTicketResource('', tasks)).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(resolveTicketResource(undefined, tasks)).toMatchObject({ ok: false, code: 'validation_failed' });
  });
});

describe('resolveDocResource (FLUX-949 docs:// read)', () => {
  const docs = {
    INDEX: doc('INDEX', { title: 'Index' }),
    'event-horizon/reference/mcp-tools': doc('event-horizon/reference/mcp-tools', { title: 'MCP Tools' }),
    'Product/features/payments': doc('Product/features/payments', { title: 'Payments', group: true }),
  };

  it('resolves a multi-segment path to the doc body', () => {
    const r = resolveDocResource('event-horizon/reference/mcp-tools', docs);
    expect(r.ok).toBe(true);
    expect(r.ok && r.body).toContain('event-horizon/reference/mcp-tools');
  });

  it('resolves docs://INDEX (bare) to the INDEX doc', () => {
    const r = resolveDocResource('INDEX', docs);
    expect(r).toMatchObject({ ok: true, key: 'INDEX' });
  });

  it('resolves docs://INDEX.md (with extension) to the same INDEX key', () => {
    const r = resolveDocResource('INDEX.md', docs);
    expect(r).toMatchObject({ ok: true, key: 'INDEX' });
  });

  it('strips a trailing .md from a nested path', () => {
    const r = resolveDocResource('event-horizon/reference/mcp-tools.md', docs);
    expect(r).toMatchObject({ ok: true, key: 'event-horizon/reference/mcp-tools' });
  });

  it('rejects a parent-traversal path as validation_failed (no fs read outside .docs)', () => {
    expect(resolveDocResource('../engine/src/mcp-server.ts', docs)).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(resolveDocResource('../../etc/passwd', docs)).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(resolveDocResource('a/../../b', docs)).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('rejects an empty / non-string path as validation_failed', () => {
    expect(resolveDocResource('', docs)).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(resolveDocResource(undefined, docs)).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('returns not_found for an unknown doc path', () => {
    expect(resolveDocResource('nonexistent/file', docs)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('treats a group doc as not_found (group docs belong to the group_doc surface)', () => {
    expect(resolveDocResource('Product/features/payments', docs)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('listActiveTicketResources (FLUX-949 ticket:// list)', () => {
  it('enumerates only active (non-terminal) tickets as ticket:// URIs', () => {
    const tasks = {
      'FLUX-1': ticket('FLUX-1', { status: 'Todo' }),
      'FLUX-2': ticket('FLUX-2', { status: 'In Progress' }),
      'FLUX-3': ticket('FLUX-3', { status: 'Done' }),
      'FLUX-4': ticket('FLUX-4', { status: 'Released' }),
      'FLUX-5': ticket('FLUX-5', { status: 'Archived' }),
    };
    const rows = listActiveTicketResources(tasks, TERMINAL);
    expect(rows.map((r) => r.uri)).toEqual(['ticket://FLUX-1', 'ticket://FLUX-2']);
    expect(rows.every((r) => r.mimeType === 'application/json')).toBe(true);
    expect(rows[0]).toMatchObject({ uri: 'ticket://FLUX-1', name: 'FLUX-1', title: 'FLUX-1 title' });
  });

  it('returns an empty list when every ticket is terminal', () => {
    const tasks = { 'FLUX-3': ticket('FLUX-3', { status: 'Done' }) };
    expect(listActiveTicketResources(tasks, TERMINAL)).toEqual([]);
  });
});

describe('listDocResources (FLUX-949 docs:// list)', () => {
  it('enumerates repo docs (sorted, text/markdown) and excludes group docs', () => {
    const docs = {
      INDEX: doc('INDEX', { title: 'Index' }),
      'event-horizon/reference/mcp-tools': doc('event-horizon/reference/mcp-tools', { title: 'MCP Tools' }),
      'Product/features/payments': doc('Product/features/payments', { title: 'Payments', group: true }),
    };
    const rows = listDocResources(docs);
    // localeCompare order (case-insensitive): 'event-horizon…' before 'INDEX'.
    expect(rows.map((r) => r.uri)).toEqual([
      'docs://event-horizon/reference/mcp-tools',
      'docs://INDEX',
    ]);
    expect(rows.every((r) => r.mimeType === 'text/markdown')).toBe(true);
  });
});
