import { describe, it, expect } from 'vitest';
import { detectSuspectRead } from './ticket-read-guard.js';

// FLUX-1754: a partial or corrupt read must never win over the cached copy. These pin what counts as
// "lost" versus a real edit, because the failure mode is silent: the engine wrote the truncated
// version back and the good version survived only in the store's git history.

const cached = {
  body: 'x'.repeat(500),
  frontmatter: { id: 'T-1', title: 'A ticket', status: 'Ready', branch: 'flux/T-1', implementationLink: 'https://x', createdBy: 'Guy', history: new Array(120).fill({ type: 'comment' }) },
};

describe('detectSuspectRead', () => {
  it('is null when nothing is cached — first load has nothing to compare against', () => {
    expect(detectSuspectRead(undefined, { body: '', frontmatter: {} })).toBeNull();
  });

  it('flags THE observed shape: body emptied and identity/linkage fields dropped, title and status intact', () => {
    const incoming = { body: '', frontmatter: { title: 'A ticket', status: 'In Progress', createdBy: 'Guy', history: cached.frontmatter.history } };
    const s = detectSuspectRead(cached, incoming)!;
    expect(s).not.toBeNull();
    expect(s.reasons.join(' | ')).toMatch(/body 500 chars → empty/);
    expect(s.reasons.join(' | ')).toMatch(/lost id, branch, implementationLink/);
  });

  it('does NOT flag a real status change with everything else intact', () => {
    const incoming = { body: cached.body, frontmatter: { ...cached.frontmatter, status: 'Done', history: [...cached.frontmatter.history, { type: 'status_change' }] } };
    expect(detectSuspectRead(cached, incoming)).toBeNull();
  });

  it('does NOT flag a field cleared explicitly with null — that is how clearing is done', () => {
    const incoming = { body: cached.body, frontmatter: { ...cached.frontmatter, branch: null } };
    expect(detectSuspectRead(cached, incoming)).toBeNull();
  });

  it('allows an explicit body clear only when the caller says so', () => {
    const incoming = { body: '', frontmatter: cached.frontmatter };
    expect(detectSuspectRead(cached, incoming)).not.toBeNull();
    expect(detectSuspectRead(cached, incoming, { allowBodyClear: true })).toBeNull();
  });

  it('flags a history that shrank by more than half — history is append-only', () => {
    const incoming = { body: cached.body, frontmatter: { ...cached.frontmatter, history: new Array(10).fill({ type: 'comment' }) } };
    expect(detectSuspectRead(cached, incoming)!.reasons.join()).toMatch(/history 120 → 10/);
  });

  it('ignores the history rule on tiny histories — the cache carries a synthesized creation entry a bare file never had', () => {
    const small = { body: 'b', frontmatter: { id: 'T-2', title: 't', status: 'Todo', history: [{ type: 'activity' }] } };
    const incoming = { body: 'b', frontmatter: { id: 'T-2', title: 't updated', status: 'Todo' } };
    expect(detectSuspectRead(small, incoming)).toBeNull();
  });

  it('does not flag a body edit to a shorter but non-empty body', () => {
    const incoming = { body: 'short', frontmatter: cached.frontmatter };
    expect(detectSuspectRead(cached, incoming)).toBeNull();
  });
});
